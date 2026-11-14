/**
 * Converte o arquivo de destination (o mesmo que voce importa no BTP Cockpit) em variaveis do .env,
 * para usar o servidor MCP rodando o agente na sua maquina (Exercicio 5).
 *
 * Uso:  npx tsx scripts/destination-to-env.ts ~/Downloads/SALES_ORDER_MCP >> .env
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
    console.error("Uso: npx tsx scripts/destination-to-env.ts <arquivo da destination> >> .env");
    process.exit(1);
}

// Formato .properties: chave=valor, com ":" "=" e "\" escapados por "\"
const props: Record<string, string> = {};
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    props[line.slice(0, i).trim()] = line.slice(i + 1).replace(/\\(.)/g, "$1");
}

const missing = ["URL", "tokenServiceURL", "clientId", "clientSecret"].filter((k) => !props[k]);
if (missing.length) {
    console.error(`Arquivo incompleto, faltam: ${missing.join(", ")}`);
    process.exit(1);
}

console.log(
    [
        "",
        `# MCP do S/4HANA (gerado de ${props.Name ?? "destination"})`,
        `MCP_URL=${props.URL}`,
        `MCP_TOKEN_URL=${props.tokenServiceURL}`,
        `MCP_CLIENT_ID=${props.clientId}`,
        `MCP_CLIENT_SECRET=${props.clientSecret}`,
    ].join("\n")
);
