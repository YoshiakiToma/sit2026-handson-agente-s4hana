/**
 * HANDS-ON: tools que voce vai criar no lab.
 *
 *  Exercicio 3: listar_ordens_bloqueadas   (tool de leitura)
 *  Exercicio 4: enviar_lembrete_cobranca   (tool de escrita com human-in-the-loop)
 *
 * Uma tool tem 3 partes: a funcao (o que ela faz), o nome e a descricao (como o LLM decide
 * quando usar) e o schema zod (quais argumentos o LLM precisa preencher).
 * Modelo para copiar: srv/tools/tools.ts (consultar_ordem_venda e liberar_bloqueios_ordem).
 */
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
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
        // TODO 3.1: busque as ordens bloqueadas com getProvider().listBlockedOrders?.(customer)
        //           Se o metodo nao existir (modo s4/hybrid), devolva json({ error: "..." }).
        // TODO 3.2: devolva json({ count, orders }) so com os campos uteis ao LLM:
        //           salesOrder, customerName, netAmount, currency, creditBlocked, deliveryBlock.
        return json({ error: "Exercicio 3 ainda nao implementado." });
    },
    {
        name: "listar_ordens_bloqueadas",
        // TODO 3.3: escreva uma descricao que diga ao LLM QUANDO usar esta tool.
        description: "TODO",
        schema: z.object({
            customer: z.string().optional().describe("Codigo do cliente (SoldToParty). Omita para listar todas."),
        }),
    }
);

/* ------------------------------------------------------------------------------------------ */
/* Exercicio 4: tool de escrita com human-in-the-loop                                         */
/* ------------------------------------------------------------------------------------------ */

/** Lembretes "enviados" (em memoria: some no restart). */
const sentReminders: Array<{ customer: string; invoices: string[]; sentAt: string }> = [];

export const sendPaymentReminder = tool(
    async ({ customer, message }) => {
        // TODO 4.1: busque as faturas com getProvider().getOpenInvoices(customer) e filtre daysOverdue > 0.
        //           Sem fatura vencida: devolva um erro SEM perguntar nada ao usuario.
        // TODO 4.2: chame interrupt("Confirma o envio ...? Responda sim ou nao") e guarde a resposta.
        //           O grafo PAUSA aqui e a task A2A fica "input-required".
        // TODO 4.3: se APPROVAL.test(resposta) for falso, devolva { sent: false }.
        //           Se for verdadeiro, registre em sentReminders e devolva { sent: true, ... }.
        void interrupt;
        void APPROVAL;
        void sentReminders;
        return json({ error: "Exercicio 4 ainda nao implementado." });
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

// TODO 3.4 / 4.4: registre as tools aqui. O executor so "enxerga" o que esta nesta lista.
export const labTools: StructuredToolInterface[] = [];
