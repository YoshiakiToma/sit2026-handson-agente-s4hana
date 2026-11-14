import { v4 as uuidv4 } from "uuid";
import cds from "@sap/cds";

import type { TextPart } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";

import { Command, END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { StructuredToolInterface } from "@langchain/core/tools";
import { contentToText } from "./utils/helpers";
import { createNewTask, createStatusUpdate } from "./utils/a2a-operations";
import { collectToolResults } from "./utils/joule-view";
import type { AgentUser } from "./auth";
import { createModelWithTools, describeLlm, llmMode } from "./utils/llm";

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
    /**
     * [Hands-on, Ex. 5] Tools carregadas a cada pedido (ex.: de um servidor MCP). Somam-se a "tools".
     * Se falhar, o agente segue so com as tools locais.
     */
    extraTools?: () => Promise<StructuredToolInterface[]>;
}

const NO_EXTRAS: StructuredToolInterface[] = [];

/**
 * Ponte A2A -> LangGraph.
 *
 * - Memoria: o checkpointer usa thread_id = contextId, entao a conversa inteira na Joule
 *   (varias perguntas) compartilha o mesmo historico.
 * - Human-in-the-loop: quando uma tool chama interrupt(), a task fica "input-required".
 *   A proxima mensagem com o mesmo taskId retoma o grafo com Command({ resume }).
 */
export class LangGraphAgentExecutor implements AgentExecutor {
    private readonly logger;
    private readonly workingText: string;
    private readonly buildView?: AgentDefinition["buildView"];
    private readonly def: AgentDefinition;
    /** Memoria das conversas: fica fora do grafo para sobreviver quando o grafo e remontado (tools novas). */
    private readonly checkpointer = new MemorySaver();
    private graph?: ReturnType<LangGraphAgentExecutor["buildGraph"]>;
    private graphExtras?: StructuredToolInterface[];
    /** Dono de cada conversa (contextId -> userName): impede que outro cliente retome a conversa alheia. */
    private readonly contextOwners = new Map<string, string>();

    constructor(def: AgentDefinition) {
        this.def = def;
        this.logger = cds.log(`agent:${def.name}`);
        this.workingText = def.workingText;
        this.buildView = def.buildView;
        this.logger.info(`LLM: ${describeLlm()}`);
    }

    /** O loop do agente: LLM (agent) <-> ferramentas (tools), ate o LLM responder sem pedir tool. */
    private buildGraph(tools: StructuredToolInterface[]) {
        const { systemPrompt, fakeModel } = this.def;
        // LLM: AI Token Gateway, Generative AI Hub ou modelo roteirizado (ver srv/utils/llm.ts).
        const modelWithTools = llmMode() === "fake" ? fakeModel : createModelWithTools(tools);

        const agentNode = async (state: typeof MessagesAnnotation.State) => {
            const response = await modelWithTools.invoke([new SystemMessage(systemPrompt()), ...state.messages]);
            return { messages: [response] };
        };

        const shouldContinue = (state: typeof MessagesAnnotation.State) => {
            const last = state.messages[state.messages.length - 1] as { tool_calls?: unknown[] };
            return last?.tool_calls?.length ? "tools" : END;
        };

        return new StateGraph(MessagesAnnotation)
            .addNode("agent", agentNode)
            .addNode("tools", new ToolNode(tools))
            .addEdge(START, "agent")
            .addConditionalEdges("agent", shouldContinue, ["tools", END])
            .addEdge("tools", "agent")
            .compile({ checkpointer: this.checkpointer });
    }

    /** Remonta o grafo so quando a lista de tools extras muda (ex.: cache do MCP renovado). */
    private async getGraph() {
        let extras = NO_EXTRAS;
        if (this.def.extraTools) {
            try {
                extras = await this.def.extraTools();
            } catch (e) {
                this.logger.warn(`tools extras indisponiveis, seguindo so com as locais: ${e instanceof Error ? e.message : e}`);
            }
        }
        if (!this.graph || extras !== this.graphExtras) {
            this.graph = this.buildGraph([...this.def.tools, ...extras]);
            this.graphExtras = extras;
            if (extras.length) this.logger.info(`tools extras: ${extras.map((t) => t.name).join(", ")}`);
        }
        return this.graph;
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

        const graph = await this.getGraph();
        const config = { configurable: { thread_id: contextId, user } };
        // Retoma se a task esta input-required OU se o grafo desta conversa tem um interrupt() pendente
        // (a Joule pode mandar o "sim" sem o taskId da task que pediu a confirmacao).
        let resuming = existingTask?.status.state === "input-required";
        if (!resuming) {
            try {
                const snapshot = await graph.getState(config);
                resuming = (snapshot.tasks ?? []).some((t: any) => t.interrupts?.length);
            } catch {
                /* sem checkpoint para este contextId */
            }
        }
        this.logger.info(`task=${taskId} context=${contextId} resume=${resuming} user=${userName} text="${text.slice(0, 80)}"`);

        try {
            const input: any = resuming ? new Command({ resume: text }) : { messages: [new HumanMessage(text)] };
            const stream = await graph.stream(input, config);

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
