/** Modelo neutro do agente de gestao de ordens de venda (API_SALES_ORDER_SRV). */

export interface OrderSummary {
    salesOrder: string;
    orderType?: string;
    customer: string;
    purchaseOrderByCustomer?: string;
    salesOrganization?: string;
    creationDate?: string;
    requestedDeliveryDate?: string;
    netAmount: number;
    currency: string;
    overallStatus?: string;
}

export interface OrderItem {
    item: string;
    material: string;
    description?: string;
    quantity: number;
    unit?: string;
    netAmount: number;
    currency: string;
    plant?: string;
    /** Motivo de recusa (SalesDocumentRjcnReason). Vazio = item ativo. */
    rejectionReason?: string;
    rejectionReasonText?: string;
    processStatus?: string;
}

export interface OrderPartner {
    partnerFunction: string;
    partnerFunctionText?: string;
    partner: string;
}

export interface OrderDetails extends OrderSummary {
    distributionChannel?: string;
    division?: string;
    deliveryBlockReason?: string;
    billingBlockReason?: string;
    items: OrderItem[];
    partners: OrderPartner[];
}

export interface OrderSearch {
    customer?: string;
    purchaseOrderByCustomer?: string;
    salesOrganization?: string;
    fromDate?: string;
    toDate?: string;
    /** true = so ordens em aberto ou parcialmente processadas (status != C). */
    openOnly?: boolean;
    top: number;
}

export interface NewOrder {
    orderType: string;
    salesOrganization: string;
    distributionChannel: string;
    division: string;
    customer: string;
    purchaseOrderByCustomer?: string;
    requestedDeliveryDate?: string;
    items: { material: string; quantity: number; unit?: string; plant?: string }[];
}

export interface HeaderChanges {
    purchaseOrderByCustomer?: string;
    requestedDeliveryDate?: string;
}

export interface WriteResult {
    salesOrder: string;
    /** false quando a escrita esta desligada (S4_ORDER_WRITE) ou nao foi feita. */
    executed: boolean;
    message: string;
}

export interface OrderManagementProvider {
    readonly mode: "mock" | "s4";
    searchOrders(q: OrderSearch): Promise<OrderSummary[]>;
    getOrderDetails(salesOrder: string): Promise<OrderDetails | null>;
    createOrder(order: NewOrder): Promise<WriteResult>;
    changeHeader(salesOrder: string, changes: HeaderChanges): Promise<WriteResult>;
    changeItemQuantity(salesOrder: string, item: string, quantity: number): Promise<WriteResult>;
    rejectItem(salesOrder: string, item: string, reason: string): Promise<WriteResult>;
}

/** Funcoes de parceiro mais comuns (TPAR). */
export const PARTNER_FUNCTION_TEXT: Record<string, string> = {
    SP: "Emissor da ordem",
    AG: "Emissor da ordem",
    SH: "Recebedor da mercadoria",
    WE: "Recebedor da mercadoria",
    BP: "Recebedor da fatura",
    RE: "Recebedor da fatura",
    PY: "Pagador",
    RG: "Pagador",
    ER: "Responsavel",
    VE: "Representante de vendas",
};

/**
 * Motivos de recusa (TVAG). Padroes do SD; sobrescreva com S4_REJECTION_REASONS='{"Z1":"..."}'.
 * O agente so aceita os codigos desta lista.
 */
export const REJECTION_REASONS: Record<string, string> = {
    "00": "Atribuido pelo sistema (interno)",
    "01": "Prazo de entrega muito longo",
    "02": "Qualidade insatisfatoria",
    "03": "Muito caro",
    "04": "Concorrencia melhor",
    "05": "Garantia",
    "10": "Pedido do cliente",
    ...(() => {
        try {
            return JSON.parse(process.env.S4_REJECTION_REASONS || "{}");
        } catch {
            return {};
        }
    })(),
};

/** Normaliza o numero do item ("000010" -> "10"). */
export const normalizeItem = (item: string) => item.replace(/^0+/, "").trim() || "0";
export const normalizeOrder = (id: string) => id.replace(/^0+/, "").trim();
