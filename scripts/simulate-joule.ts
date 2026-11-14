/**
 * Simula a Joule chamando o agente via A2A, com o mesmo comportamento do call_agent.yaml:
 * a partir da 2a mensagem, sempre reenvia contextId + taskId da ultima resposta.
 *
 * Uso:  npx tsx scripts/simulate-joule.ts [URL] ["pergunta 1" "pergunta 2" ...]
 *       URL padrao: http://localhost:4004/  (agente de gestao: http://localhost:4004/order-management/)
 *
 * Autenticacao (agente implantado com XSUAA), uma das opcoes:
 *   A2A_TOKEN=<jwt>
 *   XSUAA_TOKEN_URL=https://<sub>.authentication.<regiao>.hana.ondemand.com/oauth/token
 *   XSUAA_CLIENT_ID=... XSUAA_CLIENT_SECRET=...     (cf service-key sales-order-agent-auth sales-order-agent-joule-key)
 */
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const url = args[0]?.startsWith("http") ? args.shift()! : "http://localhost:4004/";
const turns = args.length
    ? args
    : url.includes("order-management")
      ? [
            "Quais as ordens em aberto do cliente 17100002?",
            "Mostra os itens da ordem 4712",
            "Altera a quantidade do item 10 da ordem 4712 para 25",
            "sim",
        ]
      : ["Por que a ordem de venda 4711 esta bloqueada?", "Pode liberar a ordem 4711", "sim", "E a ordem 4712?"];

async function getToken(): Promise<string | undefined> {
    if (process.env.A2A_TOKEN) return process.env.A2A_TOKEN;
    const { XSUAA_TOKEN_URL: tokenUrl, XSUAA_CLIENT_ID: id, XSUAA_CLIENT_SECRET: secret } = process.env;
    if (!tokenUrl || !id || !secret) return undefined;
    const res = await fetch(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    if (!res.ok) throw new Error(`Falha ao obter token XSUAA: HTTP ${res.status} ${await res.text()}`);
    return ((await res.json()) as any).access_token;
}

let contextId: string | undefined;
let taskId: string | undefined;

async function main() {
const token = await getToken();
console.log(token ? "Autenticacao: Bearer (XSUAA)" : "Autenticacao: nenhuma (agente local / auth dummy)");
for (const text of turns) {
    const message: Record<string, unknown> = {
        kind: "message",
        messageId: randomUUID(),
        role: "user",
        parts: [{ kind: "text", text }],
    };
    if (contextId) message.contextId = contextId;
    if (taskId) message.taskId = taskId;

    const t0 = Date.now();
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "message/send", params: { message } }),
    });
    if (res.status === 401 || res.status === 403) {
        console.log(`\x1b[31m< HTTP ${res.status}: ${await res.text()}\x1b[0m`);
        process.exitCode = 1;
        return;
    }
    const body = (await res.json()) as any;
    const ms = Date.now() - t0;

    console.log(`\n\x1b[35m> Usuario:\x1b[0m ${text}`);
    if (body.error) {
        console.log(`\x1b[31m< ERRO ${body.error.code}: ${body.error.message}\x1b[0m`);
        process.exitCode = 1;
        continue;
    }
    const r = body.result;
    contextId = r.contextId;
    taskId = r.id;
    console.log(`\x1b[36m< Agente [${r.status.state}, ${ms} ms, task ${String(taskId).slice(0, 8)}]:\x1b[0m`);
    console.log(r.status.message?.parts?.[0]?.text);
    const data = r.status.message?.parts?.[1]?.data;
    if (data) console.log(`\x1b[33m  [card ${data.type}]\x1b[0m`, JSON.stringify(data));
    if (ms > 60000) console.log("\x1b[33m! Passou de 60 s: a Joule cancelaria esta chamada.\x1b[0m");
}
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
