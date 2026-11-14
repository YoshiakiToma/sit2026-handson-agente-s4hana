import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { getProvider } from "../data";
import { SCOPES } from "../auth";
import { APPROVAL, hasScope } from "./approval";
import { labTools } from "./lab-tools";

const json = (v: unknown) => JSON.stringify(v);
/** Maximo de faturas detalhadas devolvidas ao LLM (os totais consideram todas). */
const MAX_ITEMS = 10;
const fail = (e: unknown) => json({ error: e instanceof Error ? e.message : String(e) });

/** Status de processamento do SD (VBUK/VBAK): A, B, C. */
const SD_STATUS_TEXT: Record<string, string> = {
    "": "Nao relevante",
    A: "Em aberto (nao processada)",
    B: "Parcialmente processada",
    C: "Concluida",
};
const CREDIT_TEXT: Record<string, string> = {
    NOT_CHECKED: "Sem verificacao de credito",
    APPROVED: "Credito aprovado",
    BLOCKED: "Bloqueada por credito",
    PARTIAL: "Credito parcialmente aprovado",
    RELEASED: "Credito liberado manualmente",
};

/** 1. Ordem de venda: status, valores e bloqueios. */
export const getSalesOrder = tool(
    async ({ salesOrder }) => {
        try {
            const order = await getProvider().getSalesOrder(salesOrder);
            if (!order) return json({ error: `Ordem de venda ${salesOrder} nao encontrada.` });
            // Textos de negocio para os codigos do SD (o LLM nao deve interpretar codigos sozinho).
            return json({
                ...order,
                creditStatusText: CREDIT_TEXT[order.creditStatus] ?? order.creditStatus,
                overallStatusText: SD_STATUS_TEXT[order.overallStatus ?? ""] ?? order.overallStatus,
                deliveryStatusText: SD_STATUS_TEXT[order.deliveryStatus ?? ""] ?? order.deliveryStatus,
            });
        } catch (e) {
            return fail(e);
        }
    },
    {
        name: "consultar_ordem_venda",
        description:
            "Consulta uma ordem de venda no SAP S/4HANA: cliente, valor, status de credito " +
            "(creditStatus: BLOCKED = bloqueada por credito), bloqueio de remessa (deliveryBlockReason/Text) e de faturamento.",
        schema: z.object({
            salesOrder: z.string().describe("Numero da ordem de venda, ex.: 4711"),
        }),
    }
);

/** 2. Credito do cliente: limite x exposicao. */
export const getCustomerCredit = tool(
    async ({ customer }) => {
        try {
            const credit = await getProvider().getCustomerCredit(customer);
            if (!credit) {
                return json({
                    error: `Cliente ${customer} nao possui conta no Credit Management (sem limite de credito cadastrado).`,
                });
            }
            if (credit.creditExposure === undefined) return json(credit); // exposicao indisponivel (ver "note")
            const available = credit.creditLimit - credit.creditExposure;
            return json({
                ...credit,
                availableCredit: available,
                utilizationPct: credit.creditLimit ? Math.round((credit.creditExposure / credit.creditLimit) * 100) : null,
                overLimit: available < 0,
            });
        } catch (e) {
            return fail(e);
        }
    },
    {
        name: "consultar_credito_cliente",
        description:
            "Consulta a situacao de credito de um cliente: limite, exposicao, credito disponivel e classe de risco.",
        schema: z.object({
            customer: z.string().describe("Codigo do cliente (SoldToParty), ex.: 17100001"),
        }),
    }
);

/** 3. Faturas em aberto (e vencidas). */
export const getOpenInvoices = tool(
    async ({ customer }) => {
        try {
            const items = await getProvider().getOpenInvoices(customer);
            // Totais por moeda (nao se somam BRL e USD). Ao LLM vao so as partidas mais atrasadas.
            // openTotal = debitos em aberto (inclui os vencidos); creditos/pagamentos nao compensados ficam em creditsTotal,
            // senao o total em aberto (liquido) sairia MENOR que o total vencido.
            type Totals = { openCount: number; openTotal: number; overdueCount: number; overdueTotal: number; creditsTotal: number };
            const byCurrency: Record<string, Totals> = {};
            for (const i of items) {
                const t = (byCurrency[i.currency] ??= { openCount: 0, openTotal: 0, overdueCount: 0, overdueTotal: 0, creditsTotal: 0 });
                if (i.amount < 0) {
                    t.creditsTotal += i.amount;
                    continue;
                }
                t.openCount++;
                t.openTotal += i.amount;
                if (i.daysOverdue > 0) {
                    t.overdueCount++;
                    t.overdueTotal += i.amount;
                }
            }
            for (const t of Object.values(byCurrency)) {
                t.openTotal = Math.round(t.openTotal * 100) / 100;
                t.overdueTotal = Math.round(t.overdueTotal * 100) / 100;
                t.creditsTotal = Math.round(t.creditsTotal * 100) / 100;
            }
            const top = [...items].sort((a, b) => b.daysOverdue - a.daysOverdue || b.amount - a.amount).slice(0, MAX_ITEMS);
            return json({
                customer,
                openCount: items.filter((i) => i.amount >= 0).length,
                overdueCount: items.filter((i) => i.daysOverdue > 0).length,
                maxDaysOverdue: items.reduce((m, i) => Math.max(m, i.daysOverdue), 0),
                totalsByCurrency: byCurrency,
                mostOverdueItems: top,
                itemsTruncated: items.length > top.length,
                ...(items.some((i) => i.simulated) ? { simulated: true } : {}),
            });
        } catch (e) {
            return fail(e);
        }
    },
    {
        name: "listar_faturas_em_aberto",
        description: "Lista as faturas em aberto de um cliente, destacando as vencidas e os dias de atraso.",
        schema: z.object({
            customer: z.string().describe("Codigo do cliente (SoldToParty)"),
        }),
    }
);

const canRelease = (config: any) => hasScope(config, SCOPES.creditRelease);

const denied = (salesOrder: string) =>
    json({
        salesOrder,
        released: false,
        error: `Sem autorizacao: o escopo ${SCOPES.creditRelease} e necessario para liberar bloqueios da ordem.`,
    });

const hasCreditBlock = (o: { creditStatus: string }) => o.creditStatus === "BLOCKED" || o.creditStatus === "PARTIAL";

/**
 * 4. Liberacao dos bloqueios da ordem (credito e/ou remessa) com UMA confirmacao humana.
 * Exige o escopo CreditRelease, confere no sistema se ha bloqueio e SEMPRE pede aprovacao.
 */
export const releaseOrderBlocks = tool(
    async ({ salesOrder, justification }, config) => {
        // Autorizacao antes de perguntar: nao faz sentido pedir "sim" a quem nao pode liberar.
        if (!canRelease(config)) return denied(salesOrder);
        // Trava: so pede confirmacao se a ordem existe e tem bloqueio de fato (nao depende do LLM).
        let order;
        try {
            order = await getProvider().getSalesOrder(salesOrder);
        } catch (e) {
            return fail(e);
        }
        if (!order) return json({ salesOrder, released: false, error: `Ordem de venda ${salesOrder} nao encontrada.` });
        const credit = hasCreditBlock(order);
        const delivery = Boolean(order.deliveryBlockReason);
        if (!credit && !delivery) {
            return json({
                salesOrder,
                released: false,
                error: `A ordem ${salesOrder} nao tem bloqueio de credito nem de remessa (${CREDIT_TEXT[order.creditStatus] ?? order.creditStatus}). Nada a liberar.`,
            });
        }
        const blocks = [
            credit ? "- bloqueio de **credito**" : "",
            delivery
                ? `- bloqueio de **remessa** (${order.deliveryBlockReason}${order.deliveryBlockReasonText ? ` - ${order.deliveryBlockReasonText}` : ""})`
                : "",
        ].filter(Boolean);

        const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: order.currency || "BRL" });
        // Pausa o grafo. O texto serve para qualquer cliente A2A; "approval" vira o card com botoes na Joule.
        const answer = interrupt({
            text:
                `Confirma a liberacao da ordem ${salesOrder}?\n\n${blocks.join("\n")}\n\n` +
                `Justificativa: ${justification}\n\n` +
                `Responda **sim** para liberar ou **nao** para cancelar.`,
            approval: {
                salesOrder,
                customer: order.customerName ? `${order.customerName} (${order.customer})` : order.customer,
                amount: money.format(order.netAmount),
                credit: credit ? CREDIT_TEXT[order.creditStatus] ?? order.creditStatus : "Sem bloqueio",
                delivery: delivery
                    ? `${order.deliveryBlockReason}${order.deliveryBlockReasonText ? ` - ${order.deliveryBlockReasonText}` : ""}`
                    : "Sem bloqueio",
                justification,
                approveValue: `Sim, liberar a ordem ${salesOrder}`,
                rejectValue: `Nao, cancelar a liberacao da ordem ${salesOrder}`,
            },
        });
        if (!APPROVAL.test(String(answer))) {
            return json({ salesOrder, released: false, message: "Liberacao cancelada pelo usuario." });
        }
        // Na retomada o config e o da mensagem de confirmacao: revalida quem respondeu "sim".
        if (!canRelease(config)) return denied(salesOrder);

        const run = async (fn: () => Promise<unknown>) => {
            try {
                return await fn();
            } catch (e) {
                return { released: false, error: e instanceof Error ? e.message : String(e) };
            }
        };
        const p = getProvider();
        return json({
            salesOrder,
            credit: credit ? await run(() => p.releaseCreditBlock(salesOrder, justification)) : "sem bloqueio de credito",
            delivery: delivery ? await run(() => p.releaseDeliveryBlock(salesOrder, justification)) : "sem bloqueio de remessa",
        });
    },
    {
        name: "liberar_bloqueios_ordem",
        description:
            "Libera os bloqueios de uma ordem de venda (credito e/ou remessa). " +
            "Pede confirmacao explicita do usuario antes de executar. Use apenas quando o usuario pedir para liberar.",
        schema: z.object({
            salesOrder: z.string().describe("Numero da ordem de venda"),
            justification: z.string().describe("Justificativa de negocio resumida para a liberacao"),
        }),
    }
);

// [Hands-on] as tools do lab (srv/tools/lab-tools.ts) entram no fim da lista
export const tools = [getSalesOrder, getCustomerCredit, getOpenInvoices, releaseOrderBlocks, ...labTools];
