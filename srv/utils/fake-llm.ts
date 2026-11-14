import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from "uuid";

/**
 * Modelo ROTEIRIZADO para ensaio/teste (LLM_MODE=fake). Nao usa AI Core.
 * Imita o raciocinio do agente com regras fixas, chamando as mesmas tools reais.
 * Serve para validar o encanamento A2A + Joule + human-in-the-loop sem custo de LLM.
 */
const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const call = (name: string, args: Record<string, string>) => ({ name, args, id: uuidv4(), type: "tool_call" as const });

function lastToolResults(messages: BaseMessage[]): Record<string, any> {
    const out: Record<string, any> = {};
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.getType() !== "tool") break;
        try {
            out[(m as any).name] = JSON.parse(String(m.content));
        } catch {
            out[(m as any).name] = { error: String(m.content) };
        }
    }
    return out;
}

function findOrder(messages: BaseMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const match = String(messages[i].content).match(/\b(\d{4,10})\b/);
        if (messages[i].getType() === "human" && match) return match[1];
    }
    return undefined;
}

export const fakeModelWithTools = {
    async invoke(all: BaseMessage[]): Promise<AIMessage> {
        const messages = all.filter((m) => m.getType() !== "system");
        const last = messages[messages.length - 1];
        const order = findOrder(messages) ?? "4711";

        if (last.getType() === "human") {
            const text = String(last.content).toLowerCase();
            // [Hands-on] roteiro das tools do lab (srv/tools/lab-tools.ts)
            const customer = String(last.content).match(/\b(\d{8})\b/)?.[1];
            if (/lembrete|cobra/.test(text)) {
                return new AIMessage({
                    content: "",
                    tool_calls: [
                        call("enviar_lembrete_cobranca", {
                            customer: customer ?? "17100001",
                            message: "Prezado cliente, identificamos faturas vencidas. Podemos combinar o pagamento?",
                        }),
                    ],
                });
            }
            if (/quais|lista/.test(text) && /bloquead/.test(text)) {
                return new AIMessage({
                    content: "",
                    tool_calls: [call("listar_ordens_bloqueadas", customer ? { customer } : {})],
                });
            }
            if (/libera/.test(text)) {
                return new AIMessage({
                    content: "",
                    tool_calls: [
                        call("liberar_bloqueios_ordem", {
                            salesOrder: order,
                            justification: "Cliente estrategico; cobranca da fatura vencida acordada para esta semana.",
                        }),
                    ],
                });
            }
            return new AIMessage({ content: "", tool_calls: [call("consultar_ordem_venda", { salesOrder: order })] });
        }

        const r = lastToolResults(messages);
        const so = r["consultar_ordem_venda"];
        if (so) {
            if (so.error) return new AIMessage(`Nao consegui consultar a ordem ${order}: ${so.error}`);
            if (so.creditStatus === "BLOCKED" || so.creditStatus === "PARTIAL") {
                return new AIMessage({
                    content: "",
                    tool_calls: [
                        call("consultar_credito_cliente", { customer: so.customer }),
                        call("listar_faturas_em_aberto", { customer: so.customer }),
                    ],
                });
            }
            if (so.deliveryBlockReason) {
                return new AIMessage(
                    `### Ordem ${so.salesOrder}\n- O bloqueio **nao e de credito**: e um bloqueio de remessa.\n` +
                        `- Motivo: ${so.deliveryBlockReason}\n\n**Recomendacao:** resolver o motivo com a logistica e remover o bloqueio de remessa.`
                );
            }
            return new AIMessage(
                `### Ordem ${so.salesOrder}\n- Cliente: ${so.customerName ?? so.customer}\n- Valor: ${brl(so.netAmount)}\n` +
                    `- Credito: ${so.creditStatus}\n\n**A ordem nao esta bloqueada.**`
            );
        }

        const cr = r["consultar_credito_cliente"];
        const inv = r["listar_faturas_em_aberto"];
        if (cr || inv) {
            const lines = [`### Por que a ordem ${order} esta bloqueada`];
            if (cr && !cr.error) {
                lines.push(
                    `- Limite de credito de ${cr.customerName}: ${brl(cr.creditLimit)}`,
                    `- Exposicao atual: ${brl(cr.creditExposure)} (${cr.utilizationPct}% do limite)`,
                    `- Excede o limite em **${brl(-cr.availableCredit)}**`
                );
            }
            if (inv && !inv.error && inv.overdueCount > 0) {
                const worst = (inv.mostOverdueItems ?? []).filter((i: any) => i.daysOverdue > 0).sort((a: any, b: any) => b.daysOverdue - a.daysOverdue)[0];
                lines.push(`- ${inv.overdueCount} fatura vencida: ${worst.invoice}, ${brl(worst.amount)}, ${worst.daysOverdue} dias de atraso`);
            }
            if (cr?.error || inv?.error) lines.push(`- Aviso: ${cr?.error ?? inv?.error}`);
            lines.push(
                "",
                "**Recomendacao:** cobrar a fatura vencida e liberar a ordem com justificativa, ou acionar o analista de credito. Quer que eu solicite a liberacao?"
            );
            return new AIMessage(lines.join("\n"));
        }

        // [Hands-on] respostas das tools do lab
        const lab = r["listar_ordens_bloqueadas"] ?? r["enviar_lembrete_cobranca"];
        if (lab) {
            if (lab.error) return new AIMessage(`Nao consegui: ${lab.error}`);
            if (lab.orders) {
                const rows = lab.orders.map((o: any) => `| ${o.salesOrder} | ${o.customerName ?? o.customer} | ${brl(o.netAmount)} | ${o.creditBlocked ? "credito" : ""} ${o.deliveryBlock ?? ""} |`);
                return new AIMessage(`${lab.count} ordem(ns) bloqueada(s):\n\n| Ordem | Cliente | Valor | Bloqueio |\n|---|---|---|---|\n${rows.join("\n")}`);
            }
            return new AIMessage(lab.sent ? `**Lembrete enviado** ao cliente ${lab.customer} (faturas ${lab.invoices.join(", ")}).` : `**Nada enviado.** ${lab.message}`);
        }
        // Tool chamada mas nao registrada (ex.: exercicio ainda nao feito): o ToolNode devolve um erro em texto.
        const toolError = Object.values(r).find((x: any) => x?.error);
        if (toolError && !r["consultar_credito_cliente"] && !r["listar_faturas_em_aberto"] && !r["liberar_bloqueios_ordem"]) {
            return new AIMessage(`Erro ao chamar a ferramenta: ${(toolError as any).error}`);
        }

        const rel = r["liberar_bloqueios_ordem"];
        if (rel) {
            if (rel.error || rel.message) return new AIMessage(`**Nenhuma alteracao feita.** ${rel.error ?? rel.message}`);
            const part = (x: any) => (typeof x === "string" ? x : x?.message ?? x?.error);
            return new AIMessage(`**Resultado da liberacao:**\n- Credito: ${part(rel.credit)}\n- Remessa: ${part(rel.delivery)}`);
        }
        return new AIMessage("Nao entendi. Pode informar o numero da ordem de venda?");
    },
};
