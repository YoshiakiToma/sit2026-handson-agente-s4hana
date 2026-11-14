import cds from "@sap/cds";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler } from "@a2a-js/sdk/server/express";

import { LangGraphAgentExecutor } from "./agent-executor";
import { getA2aServerUrl } from "./utils/helpers";
import { getProvider, HybridProvider } from "./data";
import { getOrderProvider } from "./data/orders";
import { authenticate, getTokenUrl, SCOPES, userBuilder } from "./auth";
import { tools } from "./tools/tools";
import { orderTools } from "./tools/order-tools";
import { getOrderManagementPrompt, getSystemPrompt } from "./utils/prompts";
import { fakeModelWithTools } from "./utils/fake-llm";
import { fakeOrderModelWithTools } from "./utils/fake-llm-orders";
import { buildView } from "./utils/joule-view";
import { buildOrderView } from "./utils/joule-view-orders";

const logger = cds.log("a2a");
const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);

/** Caminho do segundo agente (gestao de ordens). O agente de bloqueios continua na raiz "/". */
const ORDER_MGMT_PATH = "/order-management";

/** Esquema OAuth2 (XSUAA) publicado nos Agent Cards; o tokenUrl real e preenchido no bootstrap. */
const xsuaaScheme = (scopes: Record<string, string>): AgentCard["securitySchemes"] => ({
    xsuaa: {
        type: "oauth2",
        description: "JWT emitido pelo XSUAA da aplicacao (destination OAuth2ClientCredentials na Joule).",
        flows: {
            clientCredentials: {
                tokenUrl: "https://<subdominio>.authentication.<regiao>.hana.ondemand.com/oauth/token",
                scopes,
            },
        },
    },
});

const agentCard: AgentCard = {
    name: "Agente de Ordens de Venda (S/4HANA)",
    description:
        "Analisa ordens de venda bloqueadas no SAP S/4HANA: identifica a causa (credito, remessa, faturamento), " +
        "consulta limite e exposicao de credito do cliente e faturas vencidas, recomenda a acao e, com aprovacao " +
        "do usuario, libera os bloqueios de credito e de remessa da ordem.",
    url: getA2aServerUrl(),
    provider: { organization: "SAP Inside Track 2026 - PoC", url: "https://community.sap.com" },
    version: "1.0.0",
    protocolVersion: "0.3.0",
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    supportsAuthenticatedExtendedCard: false,
    // OAuth2 client credentials (XSUAA). O tokenUrl real e preenchido no bootstrap quando houver binding.
    securitySchemes: xsuaaScheme({
        [SCOPES.invoke]: "Chamar o agente",
        [SCOPES.creditRelease]: "Liberar bloqueios da ordem (credito e remessa)",
    }),
    security: [{ xsuaa: [SCOPES.invoke] }],
    skills: [
        {
            id: "analisar-ordem-bloqueada",
            name: "Analisar ordem de venda bloqueada",
            description: "Explica por que uma ordem de venda esta bloqueada e recomenda como resolver.",
            tags: ["S/4HANA", "Order-to-Cash", "credito", "ordem de venda"],
            examples: [
                "Por que a ordem 4711 esta bloqueada?",
                "Qual a situacao de credito do cliente da ordem 4711?",
            ],
            outputModes: ["text/plain"],
        },
        {
            id: "liberar-bloqueios-ordem",
            name: "Liberar bloqueios da ordem (com aprovacao)",
            description: "Libera os bloqueios de credito e de remessa apos confirmacao explicita do usuario.",
            tags: ["credito", "remessa", "human-in-the-loop"],
            examples: ["Pode liberar a ordem 4711"],
            outputModes: ["text/plain"],
        },
        // [Hands-on] habilidades novas aparecem no Agent Card (descoberta A2A)
        {
            id: "cobranca",
            name: "Listar ordens bloqueadas e cobrar faturas vencidas",
            description: "Lista as ordens bloqueadas e envia lembrete de cobranca ao cliente, com aprovacao.",
            tags: ["cobranca", "human-in-the-loop"],
            examples: ["Quais ordens do cliente 17100001 estao bloqueadas?", "Envia um lembrete de cobranca ao cliente 17100001"],
            outputModes: ["text/plain"],
        },
    ],
};

const orderMgmtCard: AgentCard = {
    name: "Agente de Gestao de Ordens de Venda (S/4HANA)",
    description:
        "Consulta, cria e altera ordens de venda no SAP S/4HANA: busca ordens por cliente, pedido do cliente ou periodo, " +
        "mostra itens e parceiros, cria ordens, altera pedido do cliente, data de entrega e quantidades e recusa itens, " +
        "sempre com confirmacao do usuario antes de gravar. Nao trata bloqueios de credito ou remessa.",
    url: `${getA2aServerUrl()}${ORDER_MGMT_PATH.slice(1)}/`,
    provider: { organization: "SAP Inside Track 2026 - PoC", url: "https://community.sap.com" },
    version: "1.0.0",
    protocolVersion: "0.3.0",
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    supportsAuthenticatedExtendedCard: false,
    securitySchemes: xsuaaScheme({
        [SCOPES.invoke]: "Chamar o agente",
        [SCOPES.orderChange]: "Criar e alterar ordens de venda",
    }),
    security: [{ xsuaa: [SCOPES.invoke] }],
    skills: [
        {
            id: "consultar-ordens",
            name: "Consultar ordens de venda",
            description: "Busca ordens por cliente, pedido do cliente ou periodo e mostra itens e parceiros.",
            tags: ["S/4HANA", "SD", "ordem de venda"],
            examples: ["Quais as ordens em aberto do cliente 17100001?", "Mostra os itens da ordem 4711"],
            outputModes: ["text/plain"],
        },
        {
            id: "alterar-ordens",
            name: "Criar e alterar ordens de venda (com aprovacao)",
            description: "Cria ordens, altera pedido do cliente, data de entrega e quantidades e recusa itens apos confirmacao.",
            tags: ["S/4HANA", "SD", "human-in-the-loop"],
            examples: ["Altera a quantidade do item 10 da ordem 4711 para 20", "Recusa o item 20 da ordem 4712"],
            outputModes: ["text/plain"],
        },
    ],
};

// @ts-ignore - assinatura do evento bootstrap do CAP
cds.on("bootstrap", (app: Express) => {
    const tokenUrl = getTokenUrl();
    for (const c of [agentCard, orderMgmtCard]) {
        const flow = (c.securitySchemes?.xsuaa as any)?.flows?.clientCredentials;
        if (tokenUrl && flow) flow.tokenUrl = tokenUrl;
    }

    // Healthcheck simples para a demo
    app.get("/health", (_req: Request, res: Response) =>
        res.json({
            status: "ok",
            dataMode: getProvider().mode,
            orderManagementDataMode: getOrderProvider().mode,
            model: process.env.MODEL_NAME || "gpt-4.1",
            agents: [agentCard.url, orderMgmtCard.url],
        })
    );

    // Reset da demo (DATA_MODE=hybrid + DEMO_RESET=true): re-bloqueia a remessa das ordens de HYBRID_CREDIT_ORDERS
    // e o credito simulado. Exige JWT com o escopo CreditRelease. Escreve no S/4: apenas nas ordens configuradas.
    app.post("/demo/reset", authenticate, async (req: Request, res: Response) => {
        const provider = getProvider();
        if (process.env.DEMO_RESET !== "true" || !(provider instanceof HybridProvider)) return res.status(404).end();
        if (!req.agentUser?.hasScope(SCOPES.creditRelease)) return res.status(403).json({ error: "Escopo CreditRelease necessario" });
        logger.info(`reset da demo solicitado por ${req.agentUser.userName}`);
        res.json({ reset: await provider.resetDemo() });
    });

    // Segundo agente primeiro: o handler do agente raiz e montado em "/" e veria todos os caminhos.
    mountAgent(app, ORDER_MGMT_PATH, orderMgmtCard, new LangGraphAgentExecutor({
        name: "gestao",
        tools: orderTools,
        systemPrompt: getOrderManagementPrompt,
        fakeModel: fakeOrderModelWithTools,
        workingText: "Consultando a ordem de venda no S/4HANA...",
        buildView: buildOrderView,
    }));
    mountAgent(app, "", agentCard, new LangGraphAgentExecutor({
        name: "bloqueios",
        tools,
        systemPrompt: getSystemPrompt,
        fakeModel: fakeModelWithTools,
        workingText: "Analisando a ordem de venda...",
        buildView,
    }));

    const authKind = (cds.env.requires as any)?.auth?.kind;
    logger.info(`A2A pronto: ${agentCard.url} e ${orderMgmtCard.url} (dados: ${getProvider().mode}, auth: ${authKind})`);
    if (authKind !== "xsuaa") logger.warn("Autenticacao DESLIGADA (auth.kind != xsuaa): use apenas localmente.");
});

/**
 * Publica um agente A2A em basePath ("" = raiz): Agent Card publico e endpoint JSON-RPC
 * protegido (JWT XSUAA + Agent.Invoke). Cada agente tem seu proprio TaskStore e memoria.
 */
function mountAgent(app: Express, basePath: string, agentCard: AgentCard, executor: LangGraphAgentExecutor) {
    const taskStore = new InMemoryTaskStore();
    const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

    // Agent Card (descoberta A2A). Os dois caminhos sao usados por clientes diferentes.
    const card = (_req: Request, res: Response) => res.json(agentCard);
    app.get(`${basePath}/.well-known/agent.json`, card);
    app.get(`${basePath}/.well-known/agent-card.json`, card);

    // A Joule reenvia o taskId da ultima resposta. Se essa task ja terminou (completed/failed),
    // o SDK rejeitaria a mensagem; removemos o taskId para abrir uma nova task no MESMO contextId
    // (a memoria da conversa e preservada pelo checkpointer, chaveado por contextId).
    const dropTerminalTaskId = async (req: Request, _res: Response, next: NextFunction) => {
        try {
            const msg = req.body?.params?.message;
            // A Joule pode mandar taskId vazio ou "null" (concatenacao de null no call_agent.yaml),
            // ou um taskId que nao existe mais (restart do app). Nesses casos, abre task nova no mesmo contextId.
            if (msg && "taskId" in msg && (!msg.taskId || msg.taskId === "null" || msg.taskId === "undefined")) {
                logger.info(`taskId invalido (${JSON.stringify(msg.taskId)}): iniciando nova task`);
                delete msg.taskId;
            }
            if (msg && msg.contextId === "null") delete msg.contextId;
            if (msg?.taskId) {
                const task = await taskStore.load(msg.taskId);
                if (!task) {
                    logger.info(`taskId ${msg.taskId} desconhecido: iniciando nova task`);
                    delete msg.taskId;
                } else if (TERMINAL.has(task.status.state)) {
                    logger.info(`taskId ${msg.taskId} ja esta '${task.status.state}': iniciando nova task`);
                    delete msg.taskId;
                }
            }
        } catch (e) {
            logger.warn("dropTerminalTaskId", e);
        }
        next();
    };

    // Agent Card e /health ficam publicos (descoberta A2A); o endpoint JSON-RPC exige JWT + escopo Agent.Invoke.
    const root = basePath || "/";
    app.post(root, authenticate, express.json({ limit: "1mb" }), dropTerminalTaskId);
    app.use(root, jsonRpcHandler({ requestHandler, userBuilder }));
}

export default cds.server;
