import type { CustomerCredit, DataProvider, OpenInvoice, ReleaseResult, SalesOrder } from "./types";

/**
 * Dados ficticios para a demo. Cenario principal:
 *  - Ordem 4711 bloqueada por credito (exposicao acima do limite + fatura vencida) e com bloqueio de remessa 01
 *  - Ordem 4712 com bloqueio de remessa (nao e credito)
 *  - Ordem 4713 sem bloqueio
 * O estado vive em memoria: liberar a 4711 muda o status ate o app reiniciar.
 */

const today = () => new Date();
const isoDaysAgo = (days: number) => {
    const d = today();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
};

const customers: Record<string, CustomerCredit> = {
    "17100001": {
        customer: "17100001",
        customerName: "Mercado Bom Preco Ltda.",
        creditLimit: 500000,
        creditExposure: 545000,
        currency: "BRL",
        riskClass: "B (medio)",
    },
    "17100002": {
        customer: "17100002",
        customerName: "Distribuidora Horizonte S.A.",
        creditLimit: 800000,
        creditExposure: 210000,
        currency: "BRL",
        riskClass: "A (baixo)",
    },
};

const orders: Record<string, SalesOrder> = {
    "4711": {
        salesOrder: "4711",
        customer: "17100001",
        customerName: "Mercado Bom Preco Ltda.",
        orderType: "OR",
        creationDate: isoDaysAgo(1),
        netAmount: 85000,
        currency: "BRL",
        creditStatus: "BLOCKED",
        deliveryBlockReason: "01",
        deliveryBlockReasonText: "Limite de credito",
        overallStatus: "A",
        deliveryStatus: "A",
    },
    "4712": {
        salesOrder: "4712",
        customer: "17100002",
        customerName: "Distribuidora Horizonte S.A.",
        orderType: "OR",
        creationDate: isoDaysAgo(2),
        netAmount: 42000,
        currency: "BRL",
        creditStatus: "APPROVED",
        deliveryBlockReason: "05",
        deliveryBlockReasonText: "Aguardando confirmacao de endereco",
        overallStatus: "A",
        deliveryStatus: "A",
    },
    "4713": {
        salesOrder: "4713",
        customer: "17100002",
        customerName: "Distribuidora Horizonte S.A.",
        orderType: "OR",
        creationDate: isoDaysAgo(3),
        netAmount: 15000,
        currency: "BRL",
        creditStatus: "APPROVED",
        overallStatus: "B",
        deliveryStatus: "B",
    },
    // [Hands-on] segunda ordem bloqueada do mesmo cliente, para a listagem ter mais de um resultado
    "4714": {
        salesOrder: "4714",
        customer: "17100001",
        customerName: "Mercado Bom Preco Ltda.",
        orderType: "OR",
        creationDate: isoDaysAgo(0),
        netAmount: 23500,
        currency: "BRL",
        creditStatus: "BLOCKED",
        overallStatus: "A",
        deliveryStatus: "A",
    },
};

const invoices: OpenInvoice[] = [
    {
        invoice: "90120001",
        customer: "17100001",
        amount: 120000,
        currency: "BRL",
        documentDate: isoDaysAgo(48),
        dueDate: isoDaysAgo(18),
        daysOverdue: 18,
    },
    {
        invoice: "90120002",
        customer: "17100001",
        amount: 60000,
        currency: "BRL",
        documentDate: isoDaysAgo(10),
        dueDate: isoDaysAgo(-20),
        daysOverdue: 0,
    },
    {
        invoice: "90120010",
        customer: "17100002",
        amount: 30000,
        currency: "BRL",
        documentDate: isoDaysAgo(5),
        dueDate: isoDaysAgo(-25),
        daysOverdue: 0,
    },
];

const normalize = (id: string) => id.replace(/^0+/, "").trim();

export class MockProvider implements DataProvider {
    readonly mode = "mock" as const;

    async getSalesOrder(salesOrder: string): Promise<SalesOrder | null> {
        return orders[normalize(salesOrder)] ?? null;
    }

    async getCustomerCredit(customer: string): Promise<CustomerCredit | null> {
        return customers[normalize(customer)] ?? null;
    }

    async getOpenInvoices(customer: string): Promise<OpenInvoice[]> {
        return invoices.filter((i) => i.customer === normalize(customer));
    }

    async releaseCreditBlock(salesOrder: string, justification: string): Promise<ReleaseResult> {
        const order = orders[normalize(salesOrder)];
        if (!order) return { salesOrder, released: false, message: "Ordem nao encontrada." };
        if (order.creditStatus !== "BLOCKED" && order.creditStatus !== "PARTIAL") {
            return { salesOrder, released: false, message: "A ordem nao esta bloqueada por credito." };
        }
        order.creditStatus = "RELEASED";
        return {
            salesOrder,
            released: true,
            message: `Bloqueio de credito liberado (mock). Justificativa registrada: "${justification}".`,
        };
    }

    /** [Hands-on] Ordens com algum bloqueio (credito, remessa ou faturamento), opcionalmente de um cliente. */
    async listBlockedOrders(customer?: string): Promise<SalesOrder[]> {
        const blocked = (o: SalesOrder) =>
            o.creditStatus === "BLOCKED" || o.creditStatus === "PARTIAL" || Boolean(o.deliveryBlockReason) || Boolean(o.billingBlockReason);
        return Object.values(orders).filter((o) => blocked(o) && (!customer || o.customer === normalize(customer)));
    }

    async releaseDeliveryBlock(salesOrder: string, justification: string): Promise<ReleaseResult> {
        const order = orders[normalize(salesOrder)];
        if (!order) return { salesOrder, released: false, message: "Ordem nao encontrada." };
        if (!order.deliveryBlockReason) return { salesOrder, released: false, message: "A ordem nao tem bloqueio de remessa." };
        order.deliveryBlockReason = undefined;
        order.deliveryBlockReasonText = undefined;
        return { salesOrder, released: true, message: `Bloqueio de remessa retirado (mock). Justificativa: "${justification}".` };
    }
}
