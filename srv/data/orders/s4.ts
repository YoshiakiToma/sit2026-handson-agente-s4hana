import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import cds from "@sap/cds";
import { datetimeLit, lit, odataDate, rawLit, sapErrorMessage, toODataDate } from "../odata";
import { normalizeItem, PARTNER_FUNCTION_TEXT, REJECTION_REASONS } from "./types";
import type {
    HeaderChanges,
    NewOrder,
    OrderDetails,
    OrderItem,
    OrderManagementProvider,
    OrderSearch,
    OrderSummary,
    WriteResult,
} from "./types";

const logger = cds.log("s4-orders");

const SRV = "/sap/opu/odata/sap/API_SALES_ORDER_SRV";

const HEADER_FIELDS = [
    "SalesOrder",
    "SalesOrderType",
    "SoldToParty",
    "PurchaseOrderByCustomer",
    "SalesOrganization",
    "DistributionChannel",
    "OrganizationDivision",
    "CreationDate",
    "RequestedDeliveryDate",
    "TotalNetAmount",
    "TransactionCurrency",
    "OverallSDProcessStatus",
    "DeliveryBlockReason",
    "HeaderBillingBlockReason",
];

const writesEnabled = () => process.env.S4_ORDER_WRITE === "true";

const disabled = (salesOrder: string, what: string): WriteResult => ({
    salesOrder,
    executed: false,
    message:
        `Aprovacao registrada, mas a escrita no S/4HANA esta desativada (S4_ORDER_WRITE). ` +
        `Faca a operacao manualmente (${what}).`,
});

const toSummary = (o: any): OrderSummary => ({
    salesOrder: o.SalesOrder,
    orderType: o.SalesOrderType || undefined,
    customer: o.SoldToParty,
    purchaseOrderByCustomer: o.PurchaseOrderByCustomer || undefined,
    salesOrganization: o.SalesOrganization || undefined,
    creationDate: odataDate(o.CreationDate),
    requestedDeliveryDate: odataDate(o.RequestedDeliveryDate),
    netAmount: Number(o.TotalNetAmount),
    currency: o.TransactionCurrency,
    overallStatus: o.OverallSDProcessStatus || undefined,
});

const toItem = (i: any): OrderItem => ({
    item: normalizeItem(i.SalesOrderItem),
    material: i.Material,
    description: i.SalesOrderItemText || undefined,
    quantity: Number(i.RequestedQuantity),
    unit: i.RequestedQuantityUnit || undefined,
    netAmount: Number(i.NetAmount),
    currency: i.TransactionCurrency,
    plant: i.ProductionPlant || undefined,
    rejectionReason: i.SalesDocumentRjcnReason || undefined,
    rejectionReasonText: i.SalesDocumentRjcnReason ? REJECTION_REASONS[i.SalesDocumentRjcnReason] : undefined,
    processStatus: i.SDProcessStatus || undefined,
});

/**
 * Gestao de ordens via API_SALES_ORDER_SRV (OData V2) na BTP Destination S4_DESTINATION.
 *
 *  searchOrders        -> GET  A_SalesOrder?$filter=...
 *  getOrderDetails     -> GET  A_SalesOrder('x')?$expand=to_Item,to_Partner
 *  createOrder         -> POST A_SalesOrder (deep insert com to_Item)
 *  changeHeader        -> PATCH A_SalesOrder('x')                         (If-Match + X-CSRF-Token)
 *  changeItemQuantity  -> PATCH A_SalesOrderItem(SalesOrder,SalesOrderItem) RequestedQuantity
 *  rejectItem          -> PATCH A_SalesOrderItem(...) SalesDocumentRjcnReason
 *
 * Escritas so com S4_ORDER_WRITE=true. O usuario tecnico precisa de V_VBAK_AAT/V_VBAK_VKO (ACTVT 01 e 02).
 */
export class S4OrderManagementProvider implements OrderManagementProvider {
    readonly mode = "s4" as const;

    constructor(private readonly destinationName = process.env.S4_DESTINATION || "S4HANA_API") {}

    private request(
        config: { method: "GET" | "POST" | "PATCH"; url: string; headers?: Record<string, string>; data?: unknown },
        csrf = false
    ) {
        return executeHttpRequest(
            { destinationName: this.destinationName },
            { ...config, headers: { Accept: "application/json", ...(config.headers ?? {}) } },
            csrf ? { fetchCsrfToken: true } : undefined
        );
    }

    /** Loga status e corpo e transforma em erro legivel (mensagem do S/4 quando houver). */
    private fail(op: string, e: any): never {
        const r = e?.response;
        const body = typeof r?.data === "string" ? r.data : JSON.stringify(r?.data ?? "");
        logger.error(`${op}: ${e?.message} | status=${r?.status} | body=${body.replace(/\s+/g, " ").slice(0, 500)}`);
        throw new Error(`Falha no S/4HANA (${op}): ${sapErrorMessage(e) ?? e?.message ?? e}`);
    }

    /** PATCH com If-Match (ETag lido antes) e X-CSRF-Token. */
    private async patch(op: string, url: string, body: Record<string, unknown>): Promise<void> {
        try {
            const head = await this.request({ method: "GET", url: `${url}?$format=json` });
            const etag = head.headers?.etag ?? (head.data as any)?.d?.__metadata?.etag ?? "*";
            await this.request(
                { method: "PATCH", url, headers: { "Content-Type": "application/json", "If-Match": etag }, data: body },
                true
            );
            logger.info(`${op}: ${JSON.stringify(body)}`);
        } catch (e) {
            this.fail(op, e);
        }
    }

    async searchOrders(q: OrderSearch): Promise<OrderSummary[]> {
        const f: string[] = [];
        if (q.customer) f.push(`SoldToParty eq ${rawLit(q.customer)}`);
        if (q.purchaseOrderByCustomer) f.push(`substringof(${rawLit(q.purchaseOrderByCustomer)},PurchaseOrderByCustomer)`);
        if (q.salesOrganization) f.push(`SalesOrganization eq ${rawLit(q.salesOrganization)}`);
        if (q.fromDate) f.push(`CreationDate ge ${datetimeLit(q.fromDate)}`);
        if (q.toDate) f.push(`CreationDate le ${datetimeLit(q.toDate)}`);
        if (q.openOnly) f.push(`OverallSDProcessStatus ne 'C'`);
        const filter = f.length ? `&$filter=${encodeURIComponent(f.join(" and "))}` : "";
        try {
            const res = await this.request({
                method: "GET",
                url:
                    `${SRV}/A_SalesOrder?$select=${HEADER_FIELDS.join(",")}${filter}` +
                    `&$orderby=CreationDate%20desc&$top=${q.top}&$format=json`,
            });
            return ((res.data as any)?.d?.results ?? []).map(toSummary);
        } catch (e) {
            this.fail("buscar ordens", e);
        }
    }

    async getOrderDetails(salesOrder: string): Promise<OrderDetails | null> {
        try {
            const res = await this.request({
                method: "GET",
                url: `${SRV}/A_SalesOrder(${lit(salesOrder)})?$expand=to_Item,to_Partner&$format=json`,
            });
            const o = (res.data as any).d;
            return {
                ...toSummary(o),
                distributionChannel: o.DistributionChannel || undefined,
                division: o.OrganizationDivision || undefined,
                deliveryBlockReason: o.DeliveryBlockReason || undefined,
                billingBlockReason: o.HeaderBillingBlockReason || undefined,
                items: (o.to_Item?.results ?? []).map(toItem),
                partners: (o.to_Partner?.results ?? []).map((p: any) => ({
                    partnerFunction: p.PartnerFunction,
                    partnerFunctionText: PARTNER_FUNCTION_TEXT[p.PartnerFunction],
                    partner: p.Customer || p.Supplier || p.Personnel || p.ContactPerson || "",
                })),
            };
        } catch (e: any) {
            if (e?.response?.status === 404) return null;
            this.fail(`consultar ordem ${salesOrder}`, e);
        }
    }

    async createOrder(n: NewOrder): Promise<WriteResult> {
        if (!writesEnabled()) return disabled("(nova)", "VA01");
        const body = {
            SalesOrderType: n.orderType,
            SalesOrganization: n.salesOrganization,
            DistributionChannel: n.distributionChannel,
            OrganizationDivision: n.division,
            SoldToParty: n.customer,
            ...(n.purchaseOrderByCustomer ? { PurchaseOrderByCustomer: n.purchaseOrderByCustomer } : {}),
            ...(n.requestedDeliveryDate ? { RequestedDeliveryDate: toODataDate(n.requestedDeliveryDate) } : {}),
            to_Item: n.items.map((i) => ({
                Material: i.material,
                RequestedQuantity: String(i.quantity), // Edm.Decimal vai como string
                ...(i.unit ? { RequestedQuantityUnit: i.unit } : {}),
                ...(i.plant ? { ProductionPlant: i.plant } : {}),
            })),
        };
        try {
            const res = await this.request(
                { method: "POST", url: `${SRV}/A_SalesOrder`, headers: { "Content-Type": "application/json" }, data: body },
                true
            );
            const id = (res.data as any)?.d?.SalesOrder;
            logger.info(`ordem criada: ${id}`);
            return { salesOrder: id, executed: true, message: `Ordem de venda ${id} criada no S/4HANA.` };
        } catch (e) {
            this.fail("criar ordem", e);
        }
    }

    async changeHeader(salesOrder: string, c: HeaderChanges): Promise<WriteResult> {
        if (!writesEnabled()) return disabled(salesOrder, "VA02");
        const body: Record<string, unknown> = {};
        if (c.purchaseOrderByCustomer !== undefined) body.PurchaseOrderByCustomer = c.purchaseOrderByCustomer;
        if (c.requestedDeliveryDate !== undefined) body.RequestedDeliveryDate = toODataDate(c.requestedDeliveryDate);
        await this.patch(`alterar ordem ${salesOrder}`, `${SRV}/A_SalesOrder(${lit(salesOrder)})`, body);
        return { salesOrder, executed: true, message: "Cabecalho da ordem alterado no S/4HANA." };
    }

    private itemUrl(salesOrder: string, item: string) {
        return `${SRV}/A_SalesOrderItem(SalesOrder=${lit(salesOrder)},SalesOrderItem=${lit(normalizeItem(item))})`;
    }

    async changeItemQuantity(salesOrder: string, item: string, quantity: number): Promise<WriteResult> {
        if (!writesEnabled()) return disabled(salesOrder, "VA02");
        await this.patch(`alterar item ${salesOrder}/${item}`, this.itemUrl(salesOrder, item), {
            RequestedQuantity: String(quantity),
        });
        return { salesOrder, executed: true, message: `Quantidade do item ${normalizeItem(item)} alterada para ${quantity} no S/4HANA.` };
    }

    async rejectItem(salesOrder: string, item: string, reason: string): Promise<WriteResult> {
        if (!writesEnabled()) return disabled(salesOrder, "VA02");
        await this.patch(`recusar item ${salesOrder}/${item}`, this.itemUrl(salesOrder, item), {
            SalesDocumentRjcnReason: reason,
        });
        return { salesOrder, executed: true, message: `Item ${normalizeItem(item)} recusado no S/4HANA (motivo ${reason}).` };
    }
}
