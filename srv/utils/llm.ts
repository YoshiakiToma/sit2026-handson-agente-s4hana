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
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";

const logger = cds.log("llm");

export type LlmMode = "gateway" | "aicore" | "fake";

/** Modelo padrao por modo: o que a chave do gateway do evento libera, ou o deployment do AI Core. */
const DEFAULT_MODEL: Record<LlmMode, string> = {
    gateway: "anthropic--claude-4.5-sonnet",
    aicore: "gpt-4.1",
    fake: "gpt-4.1",
};

export const modelName = (): string => process.env.MODEL_NAME || DEFAULT_MODEL[llmMode()];

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

/**
 * O gateway repassa o campo "name" das mensagens "tool" ao Orchestration Service do AI Core, que nao aceita
 * esse campo nesse papel (erro 502 "'tool' is not one of ['system']"). O vinculo com a chamada vai pelo
 * tool_call_id, entao o "name" pode sair sem perda.
 */
function withoutToolNames(messages: BaseMessage[]): BaseMessage[] {
    return messages.map((m) =>
        ToolMessage.isInstance(m) && m.name
            ? new ToolMessage({ content: m.content, tool_call_id: m.tool_call_id, status: m.status, artifact: m.artifact })
            : m
    );
}

/** Modelo de chat com as tools ligadas (para LLM_MODE=fake, o executor usa o modelo roteirizado). */
export function createModelWithTools(tools: StructuredToolInterface[]) {
    if (llmMode() === "gateway") {
        // Projeto do gateway: implicito quando a chave pertence a um so projeto; senao, AITG_PROJECT.
        const defaultHeaders: Record<string, string> = {};
        if (process.env.AITG_PROJECT) defaultHeaders["X-AITG-Project"] = process.env.AITG_PROJECT;
        const model = new ChatOpenAI({
            model: modelName(),
            apiKey: process.env.AITG_API_KEY,
            configuration: { baseURL: gatewayBaseUrl(), defaultHeaders },
            maxRetries: 1, // 429 (RPM/TPM ou orcamento) deve aparecer para o aluno, nao virar espera longa
        }).bindTools(tools);
        return RunnableLambda.from(withoutToolNames).pipe(model);
    }
    return new OrchestrationClient({ promptTemplating: { model: { name: modelName() } } }).bindTools(tools);
}

/** Avisa uma vez no log qual LLM esta em uso. */
export function logLlm(): void {
    const text = describeLlm();
    if (llmMode() === "fake" && process.env.LLM_MODE !== "fake") logger.warn(`LLM: ${text}`);
    else logger.info(`LLM: ${text}`);
}
