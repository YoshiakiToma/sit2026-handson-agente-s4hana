/**
 * Coloca a service key do AI Core no .env e liga o LLM real (Exercicio 2).
 *
 * Uso:  npx tsx scripts/aicore-to-env.ts ~/Downloads/aicore-key.json
 *
 * Aceita o arquivo do instrutor ou a saida de "cf service-key" (com ou sem "credentials").
 * Grava AICORE_SERVICE_KEY em UMA linha e comenta LLM_MODE=fake. Nao imprime o segredo.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
    console.error("Uso: npx tsx scripts/aicore-to-env.ts <arquivo da service key do AI Core>");
    process.exit(1);
}

// A saida do "cf service-key" tem linhas de texto antes do JSON: comeca no primeiro "{".
const raw = readFileSync(file, "utf8");
let key: any;
try {
    const parsed = JSON.parse(raw.slice(raw.indexOf("{")));
    key = parsed.credentials ?? parsed;
} catch {
    console.error("O arquivo nao e um JSON valido. Peca o arquivo de novo ao instrutor.");
    process.exit(1);
}
const missing = ["clientid", "clientsecret", "url"].filter((k) => !key[k]);
if (!key.serviceurls?.AI_API_URL) missing.push("serviceurls.AI_API_URL");
if (missing.length) {
    console.error(`Nao parece uma service key do AI Core. Faltam: ${missing.join(", ")}`);
    process.exit(1);
}

const ENV = ".env";
const lines = existsSync(ENV) ? readFileSync(ENV, "utf8").split(/\r?\n/) : [];
const out = lines
    .filter((l) => !/^\s*AICORE_SERVICE_KEY=/.test(l)) // troca a chave antiga, se houver
    .map((l) => (/^\s*LLM_MODE=fake\s*$/.test(l) ? `# ${l.trim()}   (desligado: LLM real via AI Core)` : l));
while (out.length && !out[out.length - 1].trim()) out.pop();
out.push(`AICORE_SERVICE_KEY=${JSON.stringify(key)}`, "");
writeFileSync(ENV, out.join("\n"));

console.log(`OK: AICORE_SERVICE_KEY gravada em ${ENV} (${key.serviceurls.AI_API_URL}) e LLM_MODE=fake desligado.`);
console.log("O npm run dev reinicia sozinho; o log deve mostrar \"LLM: gpt-4.1\".");
