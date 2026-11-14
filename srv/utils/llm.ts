/**
 * Escolha do LLM do agente.
 *
 *  gateway  AITG_API_KEY definido: AI Token Gateway (API compativel com OpenAI) na frente do SAP AI Core.
 *           O gateway autentica a chave, aplica as policies (modelos, RPM/TPM, orcamento) e mede o consumo.
 *  aicore   AICORE_SERVICE_KEY ou binding "aicore": Generative AI Hub direto (Orchestration Service).
 *  fake     LLM_MODE=fake, ou nenhum dos dois acima: modelo roteirizado, sem custo (ensaio e testes).
 */
import cds from "@sap/cds";
import { ChatOpenAI } from "@langchain/openai";
import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import type { StructuredToolInterface } from "@langchain/core/tools";

const logger = cds.log("llm");

export type LlmMode = "gateway" | "aicore" | "fake";

export const modelName = (): string => process.env.MODEL_NAME || "gpt-4.1";

export function llmMode(): LlmMode {
    if (process.env.LLM_MODE === "fake") return "fake";
    if (process.env.AITG_API_KEY) return "gateway";
    if (process.env.AICORE_SERVICE_KEY || process.env.VCAP_SERVICES?.includes('"aicore"')) return "aicore";
    return "fake";
}

/** Texto para o log e o /health. */
export function describeLlm(): string {
    switch (llmMode()) {
        case "gateway":
            return `${modelName()} via AI Token Gateway`;
        case "aicore":
            return `${modelName()} via Generative AI Hub`;
        default:
            return process.env.LLM_MODE === "fake"
                ? "FAKE (ensaio)"
                : "FAKE (nenhum LLM configurado: defina AITG_URL e AITG_API_KEY no .env)";
    }
}

/** URL da API compativel com OpenAI do gateway: aceita a URL do servico com ou sem o "/v1". */
function gatewayBaseUrl(): string {
    const url = (process.env.AITG_URL ?? "").trim().replace(/\/+$/, "");
    if (!url) throw new Error("AITG_API_KEY definido, mas falta AITG_URL (URL do AI Token Gateway).");
    return url.endsWith("/v1") ? url : `${url}/v1`;
}

/** Modelo de chat com as tools ligadas (para LLM_MODE=fake, o executor usa o modelo roteirizado). */
export function createModelWithTools(tools: StructuredToolInterface[]) {
    if (llmMode() === "gateway") {
        // Projeto do gateway: implicito quando a chave pertence a um so projeto; senao, AITG_PROJECT.
        const defaultHeaders: Record<string, string> = {};
        if (process.env.AITG_PROJECT) defaultHeaders["X-AITG-Project"] = process.env.AITG_PROJECT;
        return new ChatOpenAI({
            model: modelName(),
            apiKey: process.env.AITG_API_KEY,
            configuration: { baseURL: gatewayBaseUrl(), defaultHeaders },
            maxRetries: 1, // 429 (RPM/TPM ou orcamento) deve aparecer para o aluno, nao virar espera longa
        }).bindTools(tools);
    }
    return new OrchestrationClient({ promptTemplating: { model: { name: modelName() } } }).bindTools(tools);
}

/** Avisa uma vez no log qual LLM esta em uso. */
export function logLlm(): void {
    const text = describeLlm();
    if (llmMode() === "fake" && process.env.LLM_MODE !== "fake") logger.warn(`LLM: ${text}`);
    else logger.info(`LLM: ${text}`);
}
