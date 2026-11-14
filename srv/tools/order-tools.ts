import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { SCOPES } from "../auth";
import { getOrderProvider, normalizeItem, REJECTION_REASONS } from "../data/orders";
import type { OrderDetails, WriteResult } from "../data/orders";
import { APPROVAL, hasScope } from "./approval";

/**
 * Tools do Agente de Gestao de Ordens de Venda (API_SALES_ORDER_SRV).
 * Leituras sao livres (escopo Agent.Invoke). Escritas exigem o escopo SalesOrder.Change,
 * conferem os dados no sistema e SEMPRE pedem uma confirmacao humana (interrupt) antes de executar.
 */

const json = (v: unknown) => JSON.stringify(v);
const fail = (e: unknown) => json({ error: e instanceof Error ? e.message : String(e) });
const MAX_RESULTS = 20;
const MAX_ITEMS = 30;

const STATUS_TEXT: Record<string, string> = {
    "": "Nao relevante",
    A: "Em aberto",
    B: "Parcialmente processada",
    C: "Concluida",
};
const statusText = (s?: string) => STATUS_TEXT[s ?? ""] ?? s;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD");
const today = () => new Date().toISOString().slice(0, 10);

const denied = (salesOrder?: string) =>
    json({
        ...(salesOrder ? { salesOrder } : {}),
        executed: false,
        error: `Sem autorizacao: o escopo ${SCOPES.orderChange} e necessario para criar ou alterar ordens de venda.`,
    });

const canChange = (config: any) => hasScope(config, SCOPES.orderChange);

/** Carrega a ordem e recusa alteracoes em ordens inexistentes ou concluidas. */
async function loadChangeable(salesOrder: string): Promise<OrderDetails | string> {
    let order: OrderDetails | null;
    try {
        order = await getOrderProvider().getOrderDetails(salesOrder);
    } catch (e) {
        return fail(e);
    }
    if (!order) return json({ salesOrder, executed: false, error: `Ordem de venda ${salesOrder} nao encontrada.` });
    if (order.overallStatus === "C") {
        return json({ salesOrder, executed: false, error: `A ordem ${salesOrder} esta concluida e nao pode ser alterada.` });
    }
    return order;
}

/**
 * Pausa o grafo e pede o "sim". "approval" vira o card com botoes na Joule (parts[1].data).
 * Na retomada, revalida o escopo de quem respondeu e executa a escrita.
 */
async function confirmAndRun(
    config: any,
    a: { salesOrder: string; title: string; subtitle: string; operation: string; details: string[]; doneTitle: string },
    run: () => Promise<WriteResult>
): Promise<string> {
    const answer = interrupt({
        text:
            `${a.title}?\n\n${a.details.map((d) => `- ${d}`).join("\n")}\n\n` +
            `Responda **sim** para confirmar ou **nao** para cancelar.`,
        approval: {
            salesOrder: a.salesOrder,
            title: a.title,
            subtitle: a.subtitle,
            operation: a.operation,
            details: a.details.join(" | "),
            approveValue: `Sim, confirmo: ${a.operation}`,
            rejectValue: `Nao, cancelar: ${a.operation}`,
        },
    });
    if (!APPROVAL.test(String(answer))) {
        return json({ salesOrder: a.salesOrder, executed: false, message: "Operacao cancelada pelo usuario." });
    }
    if (!canChange(config)) return denied(a.salesOrder);
    // confirmed/operation/doneTitle: o card de resultado na Joule so aparece depois do "sim" (joule-view-orders.ts).
    const meta = { confirmed: true, operation: a.operation, doneTitle: a.doneTitle };
    try {
        return json({ ...(await run()), ...meta });
    } catch (e) {
        return json({ salesOrder: a.salesOrder, executed: false, error: e instanceof Error ? e.message : String(e), ...meta });
    }
}

/** 1. Busca de ordens. */
export const searchOrders = tool(
    async (args) => {
        try {
            const top = Math.min(args.top ?? 10, MAX_RESULTS);
            const orders = await getOrderProvider().searchOrders({ ...args, top });
            return json({
                count: orders.length,
                mayHaveMore: orders.length === top,
                orders: orders.map((o) => ({ ...o, overallStatusText: statusText(o.overallStatus) })),
            });
        } catch (e) {
            return fail(e);
        }
    },
    {
        name: "buscar_ordens_venda",
        description:
            "Busca ordens de venda no SAP S/4HANA por cliente, pedido do cliente, organizacao de vendas e periodo de criacao. " +
            "Devolve o cabecalho de cada ordem (sem itens), da mais recente para a mais antiga.",
        schema: z.object({
            customer: z.string().optional().describe("Codigo do cliente emissor (SoldToParty)"),
            purchaseOrderByCustomer: z.string().optional().describe("Numero (ou parte) do pedido do cliente"),
            salesOrganization: z.string().optional().describe("Organizacao de vendas, ex.: 1010"),
            fromDate: isoDate.optional().describe("Criadas a partir de (AAAA-MM-DD)"),
            toDate: isoDate.optional().describe("Criadas ate (AAAA-MM-DD)"),
            openOnly: z.boolean().optional().describe("true = somente ordens nao concluidas"),
            top: z.number().int().min(1).max(MAX_RESULTS).optional().describe("Maximo de ordens (padrao 10)"),
        }),
    }
);

/** 2. Detalhes da ordem: cabecalho, itens e parceiros. */
export const getOrderDetails = tool(
    async ({ salesOrder }) => {
        try {
            const o = await getOrderProvider().getOrderDetails(salesOrder);
            if (!o) return json({ error: `Ordem de venda ${salesOrder} nao encontrada.` });
            return json({
                ...o,
                overallStatusText: statusText(o.overallStatus),
                items: o.items.slice(0, MAX_ITEMS).map((i) => ({
                    ...i,
                    processStatusText: statusText(i.processStatus),
                    rejected: Boolean(i.rejectionReason),
                })),
                itemsTruncated: o.items.length > MAX_ITEMS,
            });
        } catch (e) {
            return fail(e);
        }
    },
    {
        name: "consultar_detalhes_ordem",
        description:
            "Consulta uma ordem de venda com cabecalho, itens (material, quantidade, valor, centro, recusa) e parceiros " +
            "(emissor, recebedor, pagador). Use antes de qualquer alteracao.",
        schema: z.object({ salesOrder: z.string().describe("Numero da ordem de venda, ex.: 4711") }),
    }
);

/** 3. Criacao de ordem (deep insert com itens). */
export const createOrder = tool(
    async (args, config) => {
        if (!canChange(config)) return denied();
        if (args.requestedDeliveryDate && args.requestedDeliveryDate < today()) {
            return json({ executed: false, error: "A data de entrega desejada nao pode estar no passado." });
        }
        const details = [
            `Cliente: ${args.customer}`,
            `Tipo ${args.orderType}, org. ${args.salesOrganization}/${args.distributionChannel}/${args.division}`,
            ...(args.purchaseOrderByCustomer ? [`Pedido do cliente: ${args.purchaseOrderByCustomer}`] : []),
            ...(args.requestedDeliveryDate ? [`Entrega desejada: ${args.requestedDeliveryDate}`] : []),
            ...args.items.map(
                (i, n) => `Item ${(n + 1) * 10}: ${i.quantity} ${i.unit ?? ""} de ${i.material}${i.plant ? ` (centro ${i.plant})` : ""}`.replace(/\s+/g, " ")
            ),
        ];
        return confirmAndRun(
            config,
            {
                salesOrder: "(nova)",
                title: `Criar ordem de venda para o cliente ${args.customer}`,
                subtitle: `${args.items.length} item(ns)`,
                operation: `criar ordem para o cliente ${args.customer}`,
                details,
                doneTitle: "Ordem de venda criada",
            },
            () => getOrderProvider().createOrder(args)
        );
    },
    {
        name: "criar_ordem_venda",
        description:
            "Cria uma ordem de venda no S/4HANA com cabecalho e itens. Pede confirmacao do usuario antes de gravar. " +
            "So use quando o usuario pedir para criar uma ordem e informar cliente, materiais e quantidades.",
        schema: z.object({
            customer: z.string().describe("Cliente emissor (SoldToParty)"),
            orderType: z.string().default("OR").describe("Tipo de ordem (padrao OR)"),
            salesOrganization: z.string().describe("Organizacao de vendas, ex.: 1010"),
            distributionChannel: z.string().default("10").describe("Canal de distribuicao (padrao 10)"),
            division: z.string().default("00").describe("Setor de atividade (padrao 00)"),
            purchaseOrderByCustomer: z.string().optional().describe("Numero do pedido do cliente"),
            requestedDeliveryDate: isoDate.optional().describe("Data de entrega desejada (AAAA-MM-DD)"),
            items: z
                .array(
                    z.object({
                        material: z.string().describe("Codigo do material"),
                        quantity: z.number().positive().describe("Quantidade"),
                        unit: z.string().optional().describe("Unidade, ex.: PC"),
                        plant: z.string().optional().describe("Centro fornecedor"),
                    })
                )
                .min(1)
                .max(20),
        }),
    }
);

/** 4. Alteracao do cabecalho: pedido do cliente e data de entrega desejada. */
export const changeHeader = tool(
    async ({ salesOrder, purchaseOrderByCustomer, requestedDeliveryDate }, config) => {
        if (!canChange(config)) return denied(salesOrder);
        if (purchaseOrderByCustomer === undefined && requestedDeliveryDate === undefined) {
            return json({ salesOrder, executed: false, error: "Informe o que alterar: pedido do cliente e/ou data de entrega." });
        }
        if (requestedDeliveryDate && requestedDeliveryDate < today()) {
            return json({ salesOrder, executed: false, error: "A data de entrega desejada nao pode estar no passado." });
        }
        const order = await loadChangeable(salesOrder);
        if (typeof order === "string") return order;
        const details = [
            ...(purchaseOrderByCustomer !== undefined
                ? [`Pedido do cliente: ${order.purchaseOrderByCustomer ?? "(vazio)"} -> ${purchaseOrderByCustomer}`]
                : []),
            ...(requestedDeliveryDate !== undefined
                ? [`Entrega desejada: ${order.requestedDeliveryDate ?? "(vazia)"} -> ${requestedDeliveryDate}`]
                : []),
        ];
        return confirmAndRun(
            config,
            {
                salesOrder: order.salesOrder,
                title: `Alterar a ordem ${order.salesOrder}`,
                subtitle: `Cliente ${order.customer}`,
                operation: `alterar cabecalho da ordem ${order.salesOrder}`,
                details,
                doneTitle: `Ordem ${order.salesOrder} alterada`,
            },
            () => getOrderProvider().changeHeader(order.salesOrder, { purchaseOrderByCustomer, requestedDeliveryDate })
        );
    },
    {
        name: "alterar_ordem_venda",
        description:
            "Altera o cabecalho de uma ordem de venda: numero do pedido do cliente e/ou data de entrega desejada. " +
            "Pede confirmacao do usuario antes de gravar. Nao altera bloqueios.",
        schema: z.object({
            salesOrder: z.string().describe("Numero da ordem de venda"),
            purchaseOrderByCustomer: z.string().optional().describe("Novo numero do pedido do cliente"),
            requestedDeliveryDate: isoDate.optional().describe("Nova data de entrega desejada (AAAA-MM-DD)"),
        }),
    }
);

/** 5. Alteracao da quantidade de um item. */
export const changeItemQuantity = tool(
    async ({ salesOrder, item, quantity }, config) => {
        if (!canChange(config)) return denied(salesOrder);
        const order = await loadChangeable(salesOrder);
        if (typeof order === "string") return order;
        const it = order.items.find((i) => i.item === normalizeItem(item));
        if (!it) return json({ salesOrder, executed: false, error: `Item ${item} nao existe na ordem ${salesOrder}.` });
        if (it.rejectionReason) return json({ salesOrder, executed: false, error: `O item ${it.item} esta recusado.` });
        if (it.quantity === quantity) return json({ salesOrder, executed: false, error: `O item ${it.item} ja tem quantidade ${quantity}.` });
        return confirmAndRun(
            config,
            {
                salesOrder: order.salesOrder,
                title: `Alterar a quantidade do item ${it.item} da ordem ${order.salesOrder}`,
                subtitle: `${it.material}${it.description ? ` - ${it.description}` : ""}`,
                operation: `alterar quantidade do item ${it.item} da ordem ${order.salesOrder} para ${quantity}`,
                details: [`Material: ${it.material}`, `Quantidade: ${it.quantity} -> ${quantity} ${it.unit ?? ""}`.trim()],
                doneTitle: `Item ${it.item} da ordem ${order.salesOrder} alterado`,
            },
            () => getOrderProvider().changeItemQuantity(order.salesOrder, it.item, quantity)
        );
    },
    {
        name: "alterar_quantidade_item",
        description: "Altera a quantidade de um item da ordem de venda. Pede confirmacao do usuario antes de gravar.",
        schema: z.object({
            salesOrder: z.string().describe("Numero da ordem de venda"),
            item: z.string().describe("Numero do item, ex.: 10"),
            quantity: z.number().positive().describe("Nova quantidade"),
        }),
    }
);

/** 6. Recusa de item (motivo de recusa). */
export const rejectItem = tool(
    async ({ salesOrder, item, reason }, config) => {
        if (!canChange(config)) return denied(salesOrder);
        if (!REJECTION_REASONS[reason] || reason === "00") {
            return json({
                salesOrder,
                executed: false,
                error: "Motivo de recusa invalido.",
                validReasons: Object.fromEntries(Object.entries(REJECTION_REASONS).filter(([k]) => k !== "00")),
            });
        }
        const order = await loadChangeable(salesOrder);
        if (typeof order === "string") return order;
        const it = order.items.find((i) => i.item === normalizeItem(item));
        if (!it) return json({ salesOrder, executed: false, error: `Item ${item} nao existe na ordem ${salesOrder}.` });
        if (it.rejectionReason) return json({ salesOrder, executed: false, error: `O item ${it.item} ja esta recusado.` });
        return confirmAndRun(
            config,
            {
                salesOrder: order.salesOrder,
                title: `Recusar o item ${it.item} da ordem ${order.salesOrder}`,
                subtitle: `${it.material}${it.description ? ` - ${it.description}` : ""}`,
                operation: `recusar item ${it.item} da ordem ${order.salesOrder}`,
                details: [
                    `Material: ${it.material} (${it.quantity} ${it.unit ?? ""})`.replace(/\s+\)/, ")"),
                    `Motivo: ${reason} - ${REJECTION_REASONS[reason]}`,
                ],
                doneTitle: `Item ${it.item} da ordem ${order.salesOrder} recusado`,
            },
            () => getOrderProvider().rejectItem(order.salesOrder, it.item, reason)
        );
    },
    {
        name: "recusar_item_ordem",
        description:
            "Recusa (cancela) um item da ordem de venda com um motivo de recusa. Pede confirmacao do usuario antes de gravar. " +
            `Motivos: ${Object.entries(REJECTION_REASONS)
                .filter(([k]) => k !== "00")
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")}.`,
        schema: z.object({
            salesOrder: z.string().describe("Numero da ordem de venda"),
            item: z.string().describe("Numero do item, ex.: 20"),
            reason: z.string().describe("Codigo do motivo de recusa"),
        }),
    }
);

export const orderTools = [searchOrders, getOrderDetails, createOrder, changeHeader, changeItemQuantity, rejectItem];
