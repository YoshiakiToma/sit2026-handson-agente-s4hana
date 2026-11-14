import cds from "@sap/cds";
import { S4Provider } from "./s4-provider";
import type { CustomerCredit, DataProvider, OpenInvoice, ReleaseResult, SalesOrder } from "./types";

const logger = cds.log("hybrid");

const normalize = (id: string) => id.replace(/^0+/, "").trim();
const list = (v?: string) => new Set((v ?? "").split(",").map(normalize).filter(Boolean));

/**
 * Modo misto da demo (DATA_MODE=hybrid): tudo vem do S/4HANA real, EXCETO o credito,
 * porque o Credit Management (FSCM) nao esta configurado no sistema da demo.
 *
 *  - Ordem, bloqueio de remessa e faturas: S/4HANA real.
 *  - Bloqueio de credito: simulado nas ordens de HYBRID_CREDIT_ORDERS (ex.: "3858").
 *  - Limite e classe de risco: simulados (HYBRID_CREDIT_LIMIT, HYBRID_CREDIT_CURRENCY, HYBRID_RISK_CLASS).
 *  - Exposicao: REAL = soma das partidas em aberto do cliente na moeda do limite.
 *  - Liberacao: credito em memoria (simulado); remessa real no S/4 (S4_DELIVERY_RELEASE=true).
 *
 * Se o cliente tiver conta real no Credit Management, ela e usada no lugar da simulada.
 */
export class HybridProvider implements DataProvider {
    readonly mode = "hybrid" as const;
    readonly s4 = new S4Provider();
    readonly creditOrders = list(process.env.HYBRID_CREDIT_ORDERS);
    private readonly limit = Number(process.env.HYBRID_CREDIT_LIMIT || 5_000_000);
    private readonly currency = process.env.HYBRID_CREDIT_CURRENCY || "BRL";
    private readonly riskClass = process.env.HYBRID_RISK_CLASS || "C (alto)";
    /** Ordens cujo bloqueio de credito simulado ja foi liberado (zera no restart ou no reset da demo). */
    private readonly released = new Set<string>();

    async getSalesOrder(salesOrder: string): Promise<SalesOrder | null> {
        const order = await this.s4.getSalesOrder(salesOrder);
        if (!order || !this.creditOrders.has(normalize(order.salesOrder))) return order;
        return {
            ...order,
            creditStatus: this.released.has(normalize(order.salesOrder)) ? "RELEASED" : "BLOCKED",
            creditSimulated: true,
        };
    }

    async getCustomerCredit(customer: string): Promise<CustomerCredit | null> {
        const real = await this.s4.getCustomerCredit(customer);
        if (real) return real;
        const items = await this.s4.getOpenInvoices(customer);
        const exposure = items.filter((i) => i.currency === this.currency).reduce((sum, i) => sum + i.amount, 0);
        return {
            customer: customer.trim(),
            creditLimit: this.limit,
            creditExposure: Math.round(exposure * 100) / 100,
            currency: this.currency,
            riskClass: this.riskClass,
            simulated: true,
            note: "Limite e classe de risco simulados; exposicao = partidas em aberto reais do cliente no S/4HANA.",
        };
    }

    getOpenInvoices(customer: string): Promise<OpenInvoice[]> {
        return this.s4.getOpenInvoices(customer);
    }

    async releaseCreditBlock(salesOrder: string, justification: string): Promise<ReleaseResult> {
        const id = normalize(salesOrder);
        if (!this.creditOrders.has(id)) return this.s4.releaseCreditBlock(salesOrder, justification);
        if (this.released.has(id)) return { salesOrder, released: false, message: "O credito ja estava liberado." };
        this.released.add(id);
        logger.info(`credito simulado liberado: ${id} (${justification})`);
        return {
            salesOrder,
            released: true,
            message: `Bloqueio de credito liberado. Justificativa: "${justification}".`,
        };
    }

    releaseDeliveryBlock(salesOrder: string, justification: string): Promise<ReleaseResult> {
        return this.s4.releaseDeliveryBlock(salesOrder, justification);
    }

    /** Volta a demo ao estado inicial: bloqueia a remessa das ordens da demo e re-bloqueia o credito simulado. */
    async resetDemo(reason = process.env.HYBRID_DELIVERY_BLOCK || "01") {
        this.released.clear();
        const results: Record<string, string> = {};
        for (const order of this.creditOrders) {
            try {
                await this.s4.setDeliveryBlock(order, reason);
                results[order] = `bloqueio de remessa ${reason} aplicado; credito simulado bloqueado`;
            } catch (e: any) {
                results[order] = `erro: ${e?.message ?? e}`;
            }
        }
        return results;
    }
}
