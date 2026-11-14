/**
 * HANDS-ON, Exercicio 5: tools vindas de um servidor MCP (S/4HANA real) 
 *
 * Diferente dos exercicios 3 e 4, aqui voce NAO escreve a tool: o servidor MCP publica as tools
 * (s4_describe, s4_query, s4_call) e o agente as descobre em tempo de execucao.
 *
 *  Parte 1 (pronta):  getMcpConnection()  onde esta o servidor e como autenticar
 *  Parte 2 (sua):     loadMcpTools()      conectar, listar e escolher quais tools o agente pode usar
 */
import cds from "@sap/cds";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { MCPAdapter } from "@langchain/mcp-adapters";
import { buildHeadersForDestination, getDestination } from "@sap-cloud-sdk/connectivity";

const logger = cds.log("mcp");

/** Nome da destination no BTP (o arquivo que o instrutor distribuiu). */
const DESTINATION = process.env.MCP_DESTINATION || "SALES_ORDER_MCP";
/** O token do XSUAA vale ~12 h; renovamos a conexao bem antes disso. */
const REFRESH_MS = 30 * 60 * 1000;
/** MCP nao configurado: tenta de novo depois de 1 min. */
const RETRY_MS = 60 * 1000;
const NONE: StructuredToolInterface[] = [];

type Connection = { url: string; headers: Record<string, string> };

/* ------------------------------------------------------------------------------------------ */
/* Parte 1 (pronta): onde esta o servidor MCP e como autenticar                               */
/* ------------------------------------------------------------------------------------------ */

export async function getMcpConnection(): Promise<Connection | undefined> {
    // No BTP: a destination guarda URL e credenciais. O Cloud SDK busca o token OAuth por voce.
    if (process.env.VCAP_APPLICATION) {
        const destination = await getDestination({ destinationName: DESTINATION });
        if (!destination?.url) return undefined;
        return { url: destination.url, headers: await buildHeadersForDestination(destination) };
    }

    // Na sua maquina: os mesmos dados no .env (gere com: npx tsx scripts/destination-to-env.ts <arquivo>)
    const { MCP_URL, MCP_TOKEN_URL, MCP_CLIENT_ID, MCP_CLIENT_SECRET } = process.env;
    if (!MCP_URL || !MCP_TOKEN_URL || !MCP_CLIENT_ID || !MCP_CLIENT_SECRET) return undefined;
    const res = await fetch(MCP_TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: "Basic " + Buffer.from(`${MCP_CLIENT_ID}:${MCP_CLIENT_SECRET}`).toString("base64"),
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    if (!res.ok) throw new Error(`token do MCP: HTTP ${res.status}`);
    const { access_token } = (await res.json()) as { access_token: string };
    return { url: MCP_URL, headers: { Authorization: `Bearer ${access_token}` } };
}

/* ------------------------------------------------------------------------------------------ */
/* Parte 2 (exercicio): conectar, listar e escolher as tools                                  */
/* ------------------------------------------------------------------------------------------ */

let cache: { tools: StructuredToolInterface[]; adapter?: MCPAdapter; until: number } | undefined;

/** Chamada pelo executor a cada pedido (ver extraTools em srv/server.ts). */
export async function loadMcpTools(): Promise<StructuredToolInterface[]> {
    if (cache && Date.now() < cache.until) return cache.tools;

    const connection = await getMcpConnection();
    if (!connection) {
        cache = { tools: NONE, until: Date.now() + RETRY_MS };
        return NONE; // sem MCP configurado, o agente segue so com as tools locais
    }

    // TODO 5.1: crie o adapter:  const adapter = new MCPAdapter({ servers: { s4: connection } });
    //           O nome "s4" vira prefixo das tools: s4_describe, s4_query, s4_call.
    // TODO 5.2: descubra as tools do servidor:  const all = await adapter.listTools();
    // TODO 5.3: menor privilegio: s4_call cria e altera ordens no S/4 e NAO pede o "sim" do usuario.
    //           Filtre para o agente receber so as tools de leitura.
    // TODO 5.4: apague as 2 linhas abaixo e descomente o bloco seguinte.
    void MCPAdapter;
    return NONE;

    // const tools = all.filter((t) => ...);
    // await cache?.adapter?.close().catch(() => undefined);
    // cache = { tools, adapter, until: Date.now() + REFRESH_MS };
    // logger.info(`MCP conectado (${connection.url}): ${tools.map((t) => t.name).join(", ")}`);
    // return tools;
}
