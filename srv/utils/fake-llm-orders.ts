import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from "uuid";

/**
 * Modelo ROTEIRIZADO do agente de gestao de ordens (LLM_MODE=fake). Nao usa AI Core.
 * Entende frases simples e chama as tools reais, para testar A2A + Joule + confirmacao sem LLM.
 */
const brl = (v: number, currency = "BRL") => v.toLocaleString("pt-BR", { style: "currency", currency: currency || "BRL" });
const call = (name: string, args: Record<string, unknown>) => ({ name, args, id: uuidv4(), type: "tool_call" as const });
const toolCall = (name: string, args: Record<string, unknown>) => new AIMessage({ content: "", tool_calls: [call(name, args)] });

function lastToolResult(messages: BaseMessage[]): { name: string; value: any } | undefined {
    const m = messages[messages.length - 1];
    if (m?.getType() !== "tool") return undefined;
    try {
        return { name: (m as any).name, value: JSON.parse(String(m.content)) };
    } catch {
        return { name: (m as any).name, value: { error: String(m.content) } };
    }
}

function route(text: string): AIMessage {
    const t = text.toLowerCase();
    const order = /ordem\s*(?:de venda\s*)?(\d{3,10})/.exec(t)?.[1];
    const itemNo = /item\s*(\d{1,6})/.exec(t)?.[1];
    const customer = /cliente\s*(\w+)/.exec(t)?.[1];

    if (/\bcri(a|ar|e)\b/.test(t) && customer) {
        const items = [...text.matchAll(/(\d+)\s*(?:x|unidades? de|pc de)?\s*([A-Z]{2,}\d+)/g)].map((m) => ({
            material: m[2],
            quantity: Number(m[1]),
        }));
        if (!items.length) return new AIMessage("Quais materiais e quantidades devo incluir na ordem?");
        return toolCall("criar_ordem_venda", {
            customer,
            orderType: "OR",
            salesOrganization: "1010",
            distributionChannel: "10",
            division: "00",
            items,
        });
    }
    if (/quantidade/.test(t) && order && itemNo) {
        const qty = /para\s*(\d+(?:[.,]\d+)?)/.exec(t)?.[1];
        if (!qty) return new AIMessage("Qual a nova quantidade do item?");
        return toolCall("alterar_quantidade_item", { salesOrder: order, item: itemNo, quantity: Number(qty.replace(",", ".")) });
    }
    if (/recus|cancela.*item/.test(t) && order && itemNo) {
        return toolCall("recusar_item_ordem", { salesOrder: order, item: itemNo, reason: /motivo\s*(\w{2})/.exec(t)?.[1] ?? "10" });
    }
    if (/(entrega|pedido do cliente)/.test(t) && /(alter|mud|troc)/.test(t) && order) {
        const date = /(\d{4}-\d{2}-\d{2})/.exec(t)?.[1];
        const po = /pedido do cliente\s*(?:para\s*)?([\w-]+)/.exec(text)?.[1];
        return toolCall("alterar_ordem_venda", {
            salesOrder: order,
            ...(date ? { requestedDeliveryDate: date } : {}),
            ...(po && !/para/i.test(po) ? { purchaseOrderByCustomer: po } : {}),
        });
    }
    if (/(ordens|lista|busca)/.test(t) && customer) {
        return toolCall("buscar_ordens_venda", { customer, openOnly: /abert/.test(t), top: 10 });
    }
    if (order) return toolCall("consultar_detalhes_ordem", { salesOrder: order });
    return new AIMessage("Posso consultar, criar ou alterar ordens de venda. Qual o numero da ordem ou o cliente?");
}

function summarize(name: string, r: any): AIMessage {
    if (r.error) return new AIMessage(`**Nao foi possivel concluir.** ${r.error}`);
    switch (name) {
        case "buscar_ordens_venda": {
            if (!r.count) return new AIMessage("Nenhuma ordem encontrada com esses filtros.");
            const rows = r.orders.map(
                (o: any) => `| ${o.salesOrder} | ${o.creationDate ?? ""} | ${o.purchaseOrderByCustomer ?? ""} | ${brl(o.netAmount, o.currency)} | ${o.overallStatusText} |`
            );
            return new AIMessage(
                [`### ${r.count} ordem(ns) encontrada(s)`, "| Ordem | Criacao | Pedido cliente | Valor | Status |", "|---|---|---|---|---|", ...rows].join("\n")
            );
        }
        case "consultar_detalhes_ordem": {
            const rows = r.items.map(
                (i: any) =>
                    `| ${i.item} | ${i.material} | ${i.quantity} ${i.unit ?? ""} | ${brl(i.netAmount, i.currency)} | ${i.rejected ? `Recusado (${i.rejectionReason})` : i.processStatusText} |`
            );
            return new AIMessage(
                [
                    `### Ordem ${r.salesOrder}`,
                    `- Cliente: ${r.customer} · Pedido do cliente: ${r.purchaseOrderByCustomer ?? "-"}`,
                    `- Valor: ${brl(r.netAmount, r.currency)} · Status: ${r.overallStatusText}`,
                    "",
                    "| Item | Material | Qtd | Valor | Status |",
                    "|---|---|---|---|---|",
                    ...rows,
                ].join("\n")
            );
        }
        default:
            return new AIMessage(r.executed ? `**Feito.** ${r.message}` : `**Nenhuma alteracao feita.** ${r.message ?? ""}`);
    }
}

export const fakeOrderModelWithTools = {
    async invoke(all: BaseMessage[]): Promise<AIMessage> {
        const messages = all.filter((m) => m.getType() !== "system");
        const tr = lastToolResult(messages);
        if (tr) return summarize(tr.name, tr.value);
        return route(String(messages[messages.length - 1]?.content ?? ""));
    },
};
