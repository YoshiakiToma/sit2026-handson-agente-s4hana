/**
 * HANDS-ON: tools criadas no lab (SOLUCAO).
 *
 *  Exercicio 3: listar_ordens_bloqueadas   (tool de leitura)
 *  Exercicio 4: enviar_lembrete_cobranca   (tool de escrita com human-in-the-loop)
 *
 * Uma tool tem 3 partes: a funcao (o que ela faz), o nome e a descricao (como o LLM decide
 * quando usar) e o schema zod (quais argumentos o LLM precisa preencher).
 */
import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { getProvider } from "../data";
import { APPROVAL } from "./approval";

const json = (v: unknown) => JSON.stringify(v);

/* ------------------------------------------------------------------------------------------ */
/* Exercicio 3: tool de leitura                                                               */
/* ------------------------------------------------------------------------------------------ */

export const listBlockedOrders = tool(
    async ({ customer }) => {
        const provider = getProvider();
        if (!provider.listBlockedOrders) {
            return json({ error: `A listagem de ordens bloqueadas nao esta disponivel no modo ${provider.mode}.` });
        }
        const orders = await provider.listBlockedOrders(customer);
        // Devolva ao LLM so o que ele precisa: menos tokens e menos chance de confusao.
        return json({
            count: orders.length,
            orders: orders.map((o) => ({
                salesOrder: o.salesOrder,
                customer: o.customer,
                customerName: o.customerName,
                netAmount: o.netAmount,
                currency: o.currency,
                creditBlocked: o.creditStatus === "BLOCKED" || o.creditStatus === "PARTIAL",
                deliveryBlock: o.deliveryBlockReasonText ?? o.deliveryBlockReason ?? null,
            })),
        });
    },
    {
        name: "listar_ordens_bloqueadas",
        description:
            "Lista as ordens de venda com bloqueio (credito, remessa ou faturamento). " +
            "Use quando o usuario perguntar QUAIS ordens estao bloqueadas, de um cliente ou no geral.",
        schema: z.object({
            customer: z.string().optional().describe("Codigo do cliente (SoldToParty). Omita para listar todas."),
        }),
    }
);

/* ------------------------------------------------------------------------------------------ */
/* Exercicio 4: tool de escrita com human-in-the-loop                                         */
/* ------------------------------------------------------------------------------------------ */

/** Lembretes "enviados" (em memoria: some no restart). Num sistema real seria um e-mail ou uma atividade no S/4. */
const sentReminders: Array<{ customer: string; invoices: string[]; sentAt: string }> = [];

export const sendPaymentReminder = tool(
    async ({ customer, message }) => {
        // 1. Guarda-corpo no codigo, nao no prompt: so pergunta se houver fatura vencida de fato.
        const overdue = (await getProvider().getOpenInvoices(customer)).filter((i) => i.daysOverdue > 0);
        if (!overdue.length) {
            return json({ customer, sent: false, error: `O cliente ${customer} nao tem faturas vencidas. Nada a cobrar.` });
        }

        // 2. Pausa o grafo e devolve a pergunta ao usuario (a task A2A vira "input-required").
        const list = overdue.map((i) => `- fatura ${i.invoice}: ${i.amount} ${i.currency}, ${i.daysOverdue} dias de atraso`);
        const answer = interrupt(
            `Confirma o envio do lembrete de cobranca ao cliente ${customer}?\n\n${list.join("\n")}\n\n` +
                `Mensagem: "${message}"\n\nResponda **sim** para enviar ou **nao** para cancelar.`
        );

        // 3. Quando o usuario responde, o grafo retoma AQUI com a resposta em "answer".
        if (!APPROVAL.test(String(answer))) {
            return json({ customer, sent: false, message: "Envio cancelado pelo usuario." });
        }
        const record = { customer, invoices: overdue.map((i) => i.invoice), sentAt: new Date().toISOString() };
        sentReminders.push(record);
        return json({ sent: true, ...record, message: "Lembrete registrado (simulado)." });
    },
    {
        name: "enviar_lembrete_cobranca",
        description:
            "Envia ao cliente um lembrete de cobranca das faturas vencidas. Pede confirmacao do usuario antes de enviar. " +
            "Use apenas quando o usuario pedir para cobrar ou enviar lembrete.",
        schema: z.object({
            customer: z.string().describe("Codigo do cliente (SoldToParty)"),
            message: z.string().describe("Texto curto e cordial do lembrete, em portugues"),
        }),
    }
);

/** Registradas em srv/tools/tools.ts (export const tools = [..., ...labTools]). */
export const labTools = [listBlockedOrders, sendPaymentReminder];
