import { normalizeItem, normalizeOrder, PARTNER_FUNCTION_TEXT, REJECTION_REASONS } from "./types";
import type {
    HeaderChanges,
    NewOrder,
    OrderDetails,
    OrderManagementProvider,
    OrderSearch,
    OrderSummary,
    WriteResult,
} from "./types";

/**
 * Dados ficticios do agente de gestao (mesmos numeros e clientes do mock do agente de bloqueios).
 * Estado em memoria: criacoes e alteracoes valem ate o app reiniciar.
 */
const isoDaysAgo = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
};

/** Precos ficticios por material (para calcular o valor dos itens). */
const PRICES: Record<string, { description: string; price: number; unit: string }> = {
    "TG11": { description: "Notebook 14 polegadas", price: 4250, unit: "PC" },
    "TG12": { description: "Monitor 27 polegadas", price: 1800, unit: "PC" },
    "TG13": { description: "Dock station USB-C", price: 950, unit: "PC" },
};

const partners = (customer: string) =>
    ["SP", "SH", "BP", "PY"].map((f) => ({ partnerFunction: f, partnerFunctionText: PARTNER_FUNCTION_TEXT[f], partner: customer }));

const item = (no: string, material: string, quantity: number, plant = "1010") => ({
    item: no,
    material,
    description: PRICES[material]?.description,
    quantity,
    unit: PRICES[material]?.unit ?? "PC",
    netAmount: (PRICES[material]?.price ?? 0) * quantity,
    currency: "BRL",
    plant,
    processStatus: "A",
});

const orders: Record<string, OrderDetails> = {
    "4711": {
        salesOrder: "4711",
        orderType: "OR",
        customer: "17100001",
        purchaseOrderByCustomer: "PO-BP-2026-118",
        salesOrganization: "1010",
        distributionChannel: "10",
        division: "00",
        creationDate: isoDaysAgo(1),
        requestedDeliveryDate: isoDaysAgo(-7),
        netAmount: 0,
        currency: "BRL",
        overallStatus: "A",
        deliveryBlockReason: "01",
        items: [item("10", "TG11", 16), item("20", "TG13", 18)],
        partners: partners("17100001"),
    },
    "4712": {
        salesOrder: "4712",
        orderType: "OR",
        customer: "17100002",
        purchaseOrderByCustomer: "HZ-55821",
        salesOrganization: "1010",
        distributionChannel: "10",
        division: "00",
        creationDate: isoDaysAgo(2),
        requestedDeliveryDate: isoDaysAgo(-10),
        netAmount: 0,
        currency: "BRL",
        overallStatus: "A",
        deliveryBlockReason: "05",
        items: [item("10", "TG12", 20), item("20", "TG13", 6)],
        partners: partners("17100002"),
    },
    "4713": {
        salesOrder: "4713",
        orderType: "OR",
        customer: "17100002",
        purchaseOrderByCustomer: "HZ-55790",
        salesOrganization: "1010",
        distributionChannel: "10",
        division: "00",
        creationDate: isoDaysAgo(3),
        requestedDeliveryDate: isoDaysAgo(-3),
        netAmount: 0,
        currency: "BRL",
        overallStatus: "B",
        items: [item("10", "TG13", 15)],
        partners: partners("17100002"),
    },
};

const recalc = (o: OrderDetails) => {
    o.netAmount = o.items.filter((i) => !i.rejectionReason).reduce((s, i) => s + i.netAmount, 0);
};
Object.values(orders).forEach(recalc);

let nextNumber = 4800;

const summary = ({ items: _i, partners: _p, distributionChannel: _d, division: _v, deliveryBlockReason: _b, billingBlockReason: _f, ...s }: OrderDetails): OrderSummary => s;

export class MockOrderManagementProvider implements OrderManagementProvider {
    readonly mode = "mock" as const;

    async searchOrders(q: OrderSearch): Promise<OrderSummary[]> {
        return Object.values(orders)
            .filter((o) => !q.customer || normalizeOrder(o.customer) === normalizeOrder(q.customer))
            .filter((o) => !q.purchaseOrderByCustomer || o.purchaseOrderByCustomer?.toLowerCase().includes(q.purchaseOrderByCustomer.toLowerCase()))
            .filter((o) => !q.salesOrganization || o.salesOrganization === q.salesOrganization)
            .filter((o) => !q.fromDate || (o.creationDate ?? "") >= q.fromDate)
            .filter((o) => !q.toDate || (o.creationDate ?? "") <= q.toDate)
            .filter((o) => !q.openOnly || o.overallStatus !== "C")
            .sort((a, b) => (b.creationDate ?? "").localeCompare(a.creationDate ?? ""))
            .slice(0, q.top)
            .map(summary);
    }

    async getOrderDetails(salesOrder: string): Promise<OrderDetails | null> {
        const o = orders[normalizeOrder(salesOrder)];
        return o ? structuredClone(o) : null;
    }

    async createOrder(n: NewOrder): Promise<WriteResult> {
        const id = String(nextNumber++);
        orders[id] = {
            salesOrder: id,
            orderType: n.orderType,
            customer: n.customer,
            purchaseOrderByCustomer: n.purchaseOrderByCustomer,
            salesOrganization: n.salesOrganization,
            distributionChannel: n.distributionChannel,
            division: n.division,
            creationDate: new Date().toISOString().slice(0, 10),
            requestedDeliveryDate: n.requestedDeliveryDate,
            netAmount: 0,
            currency: "BRL",
            overallStatus: "A",
            items: n.items.map((i, idx) => item(String((idx + 1) * 10), i.material, i.quantity, i.plant)),
            partners: partners(n.customer),
        };
        recalc(orders[id]);
        return { salesOrder: id, executed: true, message: `Ordem ${id} criada (mock).` };
    }

    async changeHeader(salesOrder: string, c: HeaderChanges): Promise<WriteResult> {
        const o = orders[normalizeOrder(salesOrder)];
        if (!o) return { salesOrder, executed: false, message: "Ordem nao encontrada." };
        if (c.purchaseOrderByCustomer !== undefined) o.purchaseOrderByCustomer = c.purchaseOrderByCustomer;
        if (c.requestedDeliveryDate !== undefined) o.requestedDeliveryDate = c.requestedDeliveryDate;
        return { salesOrder, executed: true, message: "Cabecalho alterado (mock)." };
    }

    async changeItemQuantity(salesOrder: string, itemNo: string, quantity: number): Promise<WriteResult> {
        const o = orders[normalizeOrder(salesOrder)];
        const i = o?.items.find((x) => x.item === normalizeItem(itemNo));
        if (!o || !i) return { salesOrder, executed: false, message: "Ordem ou item nao encontrado." };
        i.quantity = quantity;
        i.netAmount = (PRICES[i.material]?.price ?? 0) * quantity;
        recalc(o);
        return { salesOrder, executed: true, message: `Quantidade do item ${i.item} alterada para ${quantity} (mock).` };
    }

    async rejectItem(salesOrder: string, itemNo: string, reason: string): Promise<WriteResult> {
        const o = orders[normalizeOrder(salesOrder)];
        const i = o?.items.find((x) => x.item === normalizeItem(itemNo));
        if (!o || !i) return { salesOrder, executed: false, message: "Ordem ou item nao encontrado." };
        i.rejectionReason = reason;
        i.rejectionReasonText = REJECTION_REASONS[reason];
        recalc(o);
        return { salesOrder, executed: true, message: `Item ${i.item} recusado com o motivo ${reason} (mock).` };
    }
}
