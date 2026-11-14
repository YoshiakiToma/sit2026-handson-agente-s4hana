/**
 * Monta os dados estruturados (A2A DataPart, parts[1]) que a Joule renderiza como card + botoes.
 * Os dados vem dos resultados REAIS das tools deste turno, nao do texto do LLM: o card nunca
 * mostra um numero que o sistema nao devolveu.
 *
 * Contrato com joule-capability/functions/call_agent.yaml:
 *   type  = "order" | "release_result"   (o "approval" e montado em agent-executor.ts)
 *   state = "error" | "success" | "warning"  -> statusState do card (a Joule so aceita valor fixo,
 *           por isso cada state tem o seu action_group no YAML)
 */

type ToolResults = Record<string, any>;

const NO_BLOCK = "Sem bloqueio";

const money = (value: number, currency = "BRL") => {
    try {
        return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);
    } catch {
        return `${value.toFixed(2)} ${currency}`;
    }
};

/** Le o JSON devolvido por cada tool deste turno (a ultima chamada de cada tool vence). */
export function collectToolResults(messages: Array<{ name?: string; content: unknown }>, into: ToolResults): void {
    for (const m of messages) {
        if (!m?.name) continue;
        try {
            into[m.name] = JSON.parse(String(m.content));
        } catch {
            /* resultado nao-JSON: sem card */
        }
    }
}

const isCreditBlocked = (o: any) => o.creditStatus === "BLOCKED" || o.creditStatus === "PARTIAL";

function creditSummary(credit: any, invoices: any): string | undefined {
    const parts: string[] = [];
    if (credit && !credit.error) {
        const limit = money(credit.creditLimit, credit.currency);
        parts.push(
            typeof credit.utilizationPct === "number"
                ? `Limite ${limit}, ${credit.utilizationPct}% usado`
                : `Limite ${limit} (exposicao indisponivel)`
        );
    }
    if (invoices && !invoices.error) {
        const overdue = Object.entries(invoices.totalsByCurrency ?? {})
            .filter(([, t]: [string, any]) => t.overdueCount > 0)
            .map(([cur, t]: [string, any]) => money(t.overdueTotal, cur));
        parts.push(
            overdue.length
                ? `${invoices.overdueCount} fatura(s) vencida(s): ${overdue.join(" + ")}, ate ${invoices.maxDaysOverdue} dias`
                : "Nenhuma fatura vencida"
        );
    }
    return parts.length ? parts.join(" | ") : undefined;
}

function orderView(order: any, credit: any, invoices: any) {
    const delivery = order.deliveryBlockReason
        ? `${order.deliveryBlockReason}${order.deliveryBlockReasonText ? ` - ${order.deliveryBlockReasonText}` : ""}`
        : NO_BLOCK;
    const blocked = isCreditBlocked(order) || Boolean(order.deliveryBlockReason) || Boolean(order.billingBlockReason);
    // So usa credito/faturas se forem do cliente desta ordem.
    const sameCustomer = (r: any) => r && (r.customer === undefined || r.customer === order.customer);
    const summary = creditSummary(sameCustomer(credit) ? credit : undefined, sameCustomer(invoices) ? invoices : undefined);
    const so = order.salesOrder;
    return {
        type: "order",
        state: blocked ? "error" : "success",
        blocked,
        analyzed: Boolean(summary),
        salesOrder: so,
        title: `Ordem de venda ${so}`,
        customer: order.customerName ? `${order.customerName} (${order.customer})` : order.customer,
        status: blocked ? "Bloqueada" : "Sem bloqueio",
        description: summary ?? "Dados atuais do SAP S/4HANA",
        amount: money(order.netAmount, order.currency || "BRL"),
        credit: order.creditStatusText ?? order.creditStatus,
        delivery,
        billing: order.billingBlockReason || NO_BLOCK,
        askWhy: `Por que a ordem ${so} esta bloqueada?`,
        askRelease: `Pode liberar a ordem ${so}`,
    };
}

/** Resultado de um bloqueio: objeto ReleaseResult, erro, ou string "sem bloqueio de ...". */
function step(r: any): { applies: boolean; ok: boolean; text: string } {
    if (typeof r === "string") return { applies: false, ok: true, text: NO_BLOCK };
    // Card curto: o detalhe (com a justificativa) ja vai no texto do agente.
    if (r?.released) return { applies: true, ok: true, text: "Liberado" };
    return { applies: true, ok: false, text: `Falhou: ${r?.error ?? r?.message ?? "erro desconhecido"}` };
}

function releaseView(rel: any) {
    const credit = step(rel.credit);
    const delivery = step(rel.delivery);
    const applied = [credit, delivery].filter((s) => s.applies);
    const okCount = applied.filter((s) => s.ok).length;
    const state = okCount === applied.length ? "success" : okCount === 0 ? "error" : "warning";
    const so = rel.salesOrder;
    return {
        type: "release_result",
        state,
        salesOrder: so,
        title: state === "success" ? `Ordem ${so} liberada` : state === "error" ? `Ordem ${so} nao liberada` : `Ordem ${so} liberada parcialmente`,
        status: state === "success" ? "Liberada" : state === "error" ? "Falhou" : "Parcial",
        credit: credit.text,
        delivery: delivery.text,
        askStatus: `Qual o status da ordem de venda ${so}?`,
    };
}

/** Escolhe o card do turno: resultado de liberacao > ordem consultada. Sem card -> undefined (so texto). */
export function buildView(results: ToolResults): Record<string, unknown> | undefined {
    const rel = results["liberar_bloqueios_ordem"];
    // Liberacao cancelada / sem autorizacao / nada a liberar nao tem campos credit/delivery: fica so o texto.
    if (rel && !rel.error && rel.credit !== undefined && rel.delivery !== undefined) return releaseView(rel);

    const order = results["consultar_ordem_venda"];
    if (order && !order.error && order.salesOrder) {
        return orderView(order, results["consultar_credito_cliente"], results["listar_faturas_em_aberto"]);
    }
    return undefined;
}
