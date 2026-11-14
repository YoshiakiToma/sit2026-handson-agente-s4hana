import { v4 as uuidv4 } from "uuid";
import cds from "@sap/cds";

import type { TextPart } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";

import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import { Command, END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { StructuredToolInterface } from "@langchain/core/tools";
import { contentToText } from "./utils/helpers";
import { createNewTask, createStatusUpdate } from "./utils/a2a-operations";
import { collectToolResults } from "./utils/joule-view";
import type { AgentUser } from "./auth";

/** Configuracao de um agente: o mesmo executor serve os dois agentes do app. */
export interface AgentDefinition {
    /** Nome curto para logs (ex.: "bloqueios", "gestao"). */
    name: string;
    tools: StructuredToolInterface[];
    systemPrompt: () => string;
    /** Modelo roteirizado usado com LLM_MODE=fake. */
    fakeModel: { invoke(messages: any[]): Promise<any> };
    /** Texto do status "working" enviado a Joule. */
    workingText: string;
    /** Monta o card da resposta (parts[1].data) a partir dos resultados das tools do turno. */
    buildView?: (toolResults: Record<string, any>) => Record<string, unknown> | undefined;
}

/**
 * Ponte A2A -> LangGraph.
 *
 * - Memoria: o checkpointer usa thread_id = contextId, entao a conversa inteira na Joule
 *   (varias perguntas) compartilha o mesmo historico.
 * - Human-in-the-loop: quando uma tool chama interrupt(), a task fica "input-required".
 *   A proxima mensagem com o mesmo taskId retoma o grafo com Command({ resume }).
 */
export class LangGraphAgentExecutor implements AgentExecutor {
    private readonly graph;
    private readonly logger;
    private readonly workingText: string;
    private readonly buildView?: AgentDefinition["buildView"];
    /** Dono de cada conversa (contextId -> userName): impede que outro cliente retome a conversa alheia. */
    private readonly contextOwners = new Map<string, string>();

    constructor({ name, tools, systemPrompt, fakeModel, workingText, buildView }: AgentDefinition) {
        const logger = (this.logger = cds.log(`agent:${name}`));
        this.workingText = workingText;
        this.buildView = buildView;
        // LLM_MODE=fake -> modelo roteirizado (ensaio sem AI Core). Padrao: Generative AI Hub.
        const modelWithTools =
            process.env.LLM_MODE === "fake"
                ? fakeModel
                : new OrchestrationClient({
                      promptTemplating: { model: { name: process.env.MODEL_NAME || "gpt-4.1" } },
                  }).bindTools(tools);
        logger.info(`LLM: ${process.env.LLM_MODE === "fake" ? "FAKE (ensaio)" : process.env.MODEL_NAME || "gpt-4.1"}`);

        const agentNode = async (state: typeof MessagesAnnotation.State) => {
            const response = await modelWithTools.invoke([new SystemMessage(systemPrompt()), ...state.messages]);
            return { messages: [response] };
        };

        const shouldContinue = (state: typeof MessagesAnnotation.State) => {
            const last = state.messages[state.messages.length - 1] as { tool_calls?: unknown[] };
            return last?.tool_calls?.length ? "tools" : END;
        };

        this.graph = new StateGraph(MessagesAnnotation)
            .addNode("agent", agentNode)
            .addNode("tools", new ToolNode(tools))
            .addEdge(START, "agent")
            .addConditionalEdges("agent", shouldContinue, ["tools", END])
            .addEdge("tools", "agent")
            .compile({ checkpointer: new MemorySaver() });
    }

    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
        const userMessage = ctx.userMessage;
        const existingTask = ctx.task;
        const taskId = existingTask?.id || ctx.taskId || uuidv4();
        const contextId = userMessage.contextId || existingTask?.contextId || ctx.contextId || uuidv4();
        const ids = { taskId, contextId };

        const text = (userMessage.parts ?? [])
            .filter((p): p is TextPart => p.kind === "text")
            .map((p) => p.text)
            .join("\n")
            .trim();

        const user = ctx.context?.user as AgentUser | undefined;
        const userName = user?.userName ?? "anonymous";

        if (!existingTask) bus.publish(createNewTask(userMessage, ids));

        const owner = this.contextOwners.get(contextId);
        if (owner && owner !== userName) {
            this.logger.warn(`context=${contextId} pertence a ${owner}; acesso negado para ${userName}`);
            bus.publish(createStatusUpdate("failed", "Acesso negado: esta conversa pertence a outro usuario.", ids));
            bus.finished();
            return;
        }
        this.contextOwners.set(contextId, userName);

        bus.publish(createStatusUpdate("working", this.workingText, ids));

        const config = { configurable: { thread_id: contextId, user } };
        // Retoma se a task esta input-required OU se o grafo desta conversa tem um interrupt() pendente
        // (a Joule pode mandar o "sim" sem o taskId da task que pediu a confirmacao).
        let resuming = existingTask?.status.state === "input-required";
        if (!resuming) {
            try {
                const snapshot = await this.graph.getState(config);
                resuming = (snapshot.tasks ?? []).some((t: any) => t.interrupts?.length);
            } catch {
                /* sem checkpoint para este contextId */
            }
        }
        this.logger.info(`task=${taskId} context=${contextId} resume=${resuming} user=${userName} text="${text.slice(0, 80)}"`);

        try {
            const input: any = resuming ? new Command({ resume: text }) : { messages: [new HumanMessage(text)] };
            const stream = await this.graph.stream(input, config);

            let finalText = "";
            const toolResults: Record<string, any> = {};
            for await (const chunk of stream as AsyncIterable<Record<string, any>>) {
                if ("__interrupt__" in chunk) {
                    const value = chunk.__interrupt__[0]?.value;
                    const question = String((typeof value === "object" ? value?.text : value) ?? "Preciso da sua confirmacao.");
                    const data = typeof value === "object" && value?.approval ? { type: "approval", ...value.approval } : undefined;
                    bus.publish(createStatusUpdate("input-required", question, ids, data));
                    bus.finished();
                    return;
                }
                const toolMsgs = chunk.tools?.messages;
                if (Array.isArray(toolMsgs)) collectToolResults(toolMsgs, toolResults);
                const msgs = chunk.agent?.messages;
                // [Hands-on] torna o loop visivel no log: cada decisao do LLM de chamar uma tool
                for (const m of Array.isArray(msgs) ? msgs : []) {
                    for (const c of m.tool_calls ?? []) this.logger.info(`  -> tool ${c.name}(${JSON.stringify(c.args)})`);
                }
                if (Array.isArray(msgs) && msgs.length) {
                    const t = contentToText(msgs[msgs.length - 1].content);
                    if (t.trim()) finalText = t;
                }
            }

            // parts[1] = dados do card que a Joule mostra (montado por agente: ver utils/joule-view*.ts).
            const view = finalText ? this.buildView?.(toolResults) : undefined;
            bus.publish(createStatusUpdate("completed", finalText || "Nao consegui gerar uma resposta.", ids, view));
        } catch (e) {
            this.logger.error(`task=${taskId} failed`, e);
            const msg = e instanceof Error ? e.message : String(e);
            bus.publish(createStatusUpdate("failed", `Desculpe, ocorreu um erro no agente: ${msg}`, ids));
        }
        bus.finished();
    }

    cancelTask = async (_taskId: string, _bus: ExecutionEventBus): Promise<void> => {};
}
