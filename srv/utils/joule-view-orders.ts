/**
 * Cards do Agente de Gestao de Ordens (A2A DataPart, parts[1]), no mesmo padrao de joule-view.ts:
 * os dados vem dos resultados REAIS das tools do turno, nunca do texto do LLM.
 *
 * Contrato com joule-capability-orders/functions/call_agent.yaml:
 *   type  = "order_details" | "write_result"   (o "approval" e montado em agent-executor.ts)
 *   state = "error" | "success" | "warning"    -> statusState do card (valor fixo no YAML,
 *           por isso cada state tem o seu action_group)
 * A busca (buscar_ordens_venda) nao tem card: a lista vai em tabela markdown no texto.
 */

type ToolResults = Record<string, any>;

const WRITE_TOOLS = ["criar_ordem_venda", "alterar_ordem_venda", "alterar_quantidade_item", "recusar_item_ordem"];

const money = (value: number, currency = "BRL") => {
    try {
        return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);
    } catch {
        return `${value.toFixed(2)} ${currency}`;
    }
};

/** "2026-12-15" -> "15/12/2026". */
const br = (iso?: string) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join("/") : iso || "-");

function orderDetailsView(o: any) {
    const so = o.salesOrder;
    const items: any[] = o.items ?? [];
    const rejected = items.filter((i) => i.rejected).length;
    const blocked = Boolean(o.deliveryBlockReason) || Boolean(o.billingBlockReason);
    return {
        type: "order_details",
        state: blocked ? "error" : "success",
        blocked,
        salesOrder: so,
        title: `Ordem de venda ${so}`,
        customer: `Cliente ${o.customer}`,
        status: blocked ? "Bloqueada" : o.overallStatusText ?? "Sem bloqueio",
        description: `${o.orderType ?? "OR"} · Org. ${o.salesOrganization ?? "-"} · criada em ${br(o.creationDate)}`,
        amount: money(o.netAmount, o.currency || "BRL"),
        purchaseOrder: o.purchaseOrderByCustomer || "-",
        deliveryDate: br(o.requestedDeliveryDate),
        items: `${items.length - rejected} ativo(s)${rejected ? `, ${rejected} recusado(s)` : ""}${o.itemsTruncated ? " (lista truncada)" : ""}`,
        askBlock: `Por que a ordem ${so} esta bloqueada?`,
        askCustomerOrders: `Quais as ordens em aberto do cliente ${o.customer}?`,
    };
}

function writeResultView(r: any) {
    const state = r.error ? "error" : r.executed ? "success" : "warning";
    const so = r.salesOrder && r.salesOrder !== "(nova)" ? r.salesOrder : undefined;
    return {
        type: "write_result",
        state,
        salesOrder: so ?? "-",
        title: state === "success" ? r.doneTitle : state === "warning" ? "Nada foi gravado" : "Falha ao gravar",
        status: state === "success" ? "Gravado" : state === "warning" ? "Nao gravado" : "Falhou",
        operation: r.operation,
        // Card curto: o detalhe vai no texto do agente.
        result: state === "success" ? "Gravado no SAP S/4HANA" : r.error ?? r.message ?? "Sem detalhes",
        askStatus: so ? `Mostra os itens da ordem ${so}` : undefined,
        hasOrder: Boolean(so),
    };
}

/** Escolhe o card do turno: resultado de escrita confirmada > detalhes da ordem. Sem card -> undefined. */
export function buildOrderView(results: ToolResults): Record<string, unknown> | undefined {
    for (const name of WRITE_TOOLS) {
        const r = results[name];
        // So depois do "sim" (confirmed): validacoes, falta de escopo e cancelamento ficam so no texto.
        if (r?.confirmed) return writeResultView(r);
    }
    const o = results["consultar_detalhes_ordem"];
    if (o && !o.error && o.salesOrder) return orderDetailsView(o);
    return undefined;
}
