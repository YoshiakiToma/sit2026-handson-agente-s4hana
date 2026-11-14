/** Modelo de dados neutro usado pelas tools. Os providers (mock / S/4HANA) convertem para ele. */

export type CreditStatus =
    | "NOT_CHECKED" // ''  - nao verificado
    | "APPROVED" //    'A' - aprovado
    | "BLOCKED" //     'B' - bloqueado (nao aprovado)
    | "PARTIAL" //     'C' - parcialmente aprovado
    | "RELEASED"; //   'D' - liberado manualmente

export interface SalesOrder {
    salesOrder: string;
    customer: string;
    customerName?: string;
    orderType?: string;
    creationDate?: string;
    netAmount: number;
    currency: string;
    creditStatus: CreditStatus;
    deliveryBlockReason?: string;
    /** Texto do motivo do bloqueio de remessa (quando conhecido). */
    deliveryBlockReasonText?: string;
    billingBlockReason?: string;
    /** true quando o status de credito da ordem e simulado (modo hybrid). */
    creditSimulated?: boolean;
    overallStatus?: string;
    deliveryStatus?: string;
}

export interface CustomerCredit {
    customer: string;
    customerName?: string;
    creditLimit: number;
    /** Exposicao de credito. Ausente quando o sistema nao a expoe por API (ex.: S/4 sem API de exposicao). */
    creditExposure?: number;
    currency: string;
    riskClass?: string;
    creditSegment?: string;
    accountBlocked?: boolean;
    accountBlockReason?: string;
    note?: string;
    /** true quando o dado veio do mock (ainda nao lido do S/4HANA). */
    simulated?: boolean;
}

export interface OpenInvoice {
    invoice: string;
    customer: string;
    amount: number;
    currency: string;
    documentDate: string;
    dueDate: string;
    daysOverdue: number;
    documentType?: string;
    /** true quando o dado veio do mock (ainda nao lido do S/4HANA). */
    simulated?: boolean;
}

export interface ReleaseResult {
    salesOrder: string;
    released: boolean;
    message: string;
}

export interface DataProvider {
    readonly mode: "mock" | "s4" | "hybrid";
    getSalesOrder(salesOrder: string): Promise<SalesOrder | null>;
    getCustomerCredit(customer: string): Promise<CustomerCredit | null>;
    getOpenInvoices(customer: string): Promise<OpenInvoice[]>;
    releaseCreditBlock(salesOrder: string, justification: string): Promise<ReleaseResult>;
    /** Retira o bloqueio de remessa (DeliveryBlockReason) da ordem. */
    releaseDeliveryBlock(salesOrder: string, justification: string): Promise<ReleaseResult>;
    /** [Hands-on] Ordens com bloqueio de credito, remessa ou faturamento (opcional: so o mock implementa). */
    listBlockedOrders?(customer?: string): Promise<SalesOrder[]>;
}

/** Mapeia o campo TotalCreditCheckStatus do S/4HANA para o modelo neutro. */
export function mapCreditStatus(code: string | undefined): CreditStatus {
    switch ((code ?? "").trim()) {
        case "A":
            return "APPROVED";
        case "B":
            return "BLOCKED";
        case "C":
            return "PARTIAL";
        case "D":
            return "RELEASED";
        default:
            return "NOT_CHECKED";
    }
}
