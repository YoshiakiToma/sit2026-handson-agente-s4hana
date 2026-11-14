import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import cds from "@sap/cds";
import { mapCreditStatus } from "./types";
import { lit, odataDate } from "./odata";
import type { CustomerCredit, DataProvider, OpenInvoice, ReleaseResult, SalesOrder } from "./types";

const logger = cds.log("s4");

const SRV = {
    salesOrder: "/sap/opu/odata/sap/API_SALES_ORDER_SRV",
    credit: "/sap/opu/odata/sap/API_CRDTMBUSINESSPARTNER",
    openItems: "/sap/opu/odata/sap/API_OPLACCTGDOCITEMCUBE_SRV",
    creditBlock: "/sap/opu/odata/sap/API_SLS_DOC_WITH_CREDIT_BLOCK",
};

/** Maximo de partidas em aberto lidas por cliente (as mais antigas primeiro). */
const MAX_OPEN_ITEMS = Number(process.env.S4_MAX_OPEN_ITEMS || 1000);

/**
 * Textos dos motivos de bloqueio de remessa (TVLS). A API de ordens nao traz o texto;
 * os padroes abaixo podem ser sobrescritos com S4_DELIVERY_BLOCK_TEXTS='{"01":"..."}'.
 */
const DELIVERY_BLOCK_TEXT: Record<string, string> = {
    "01": "Limite de credito",
    "02": "Solicitado pelo cliente",
    "03": "Falta de material",
    "04": "Documentos de exportacao pendentes",
    ...(() => {
        try {
            return JSON.parse(process.env.S4_DELIVERY_BLOCK_TEXTS || "{}");
        } catch {
            return {};
        }
    })(),
};
export const deliveryBlockText = (code?: string) => (code ? DELIVERY_BLOCK_TEXT[code] : undefined);

const daysBetween = (fromIso: string, to = new Date()) =>
    Math.floor((Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) - Date.parse(fromIso)) / 86_400_000);

/**
 * Provider S/4HANA via BTP Destination (nome em S4_DESTINATION), OData V2.
 *
 *  getSalesOrder      -> API_SALES_ORDER_SRV / A_SalesOrder (credito, remessa e faturamento no cabecalho)
 *  getCustomerCredit  -> API_CRDTMBUSINESSPARTNER / CreditManagementAccount (+ CreditMgmtBusinessPartner p/ risco)
 *                        A API nao expoe a EXPOSICAO de credito: o campo fica ausente e o agente informa isso.
 *  getOpenInvoices    -> API_OPLACCTGDOCITEMCUBE_SRV / A_OperationalAcctgDocItemCube (cliente, nao compensadas)
 *  releaseCreditBlock -> API_SLS_DOC_WITH_CREDIT_BLOCK / ReleaseCreditBlock, SOMENTE com S4_CREDIT_RELEASE=true.
 *                        Sem a flag, devolve a orientacao (app "Release Blocked Documents" / VKM1).
 *  releaseDeliveryBlock -> API_SALES_ORDER_SRV / PATCH A_SalesOrder (DeliveryBlockReason = ""),
 *                        SOMENTE com S4_DELIVERY_RELEASE=true. Exige autorizacao de modificacao (V_VBAK_AAT/VKO 02).
 */
export class S4Provider implements DataProvider {
    readonly mode = "s4" as const;
    private readonly destinationName: string;

    constructor(destinationName = process.env.S4_DESTINATION || "S4HANA_API") {
        this.destinationName = destinationName;
    }

    private async get<T = any>(url: string): Promise<T> {
        const res = await executeHttpRequest(
            { destinationName: this.destinationName },
            { method: "GET", url, headers: { Accept: "application/json" } }
        );
        return res.data as T;
    }

    /** Registra o erro com status e corpo (diagnostico de Cloud Connector / autorizacao) e devolve o status. */
    private logError(op: string, e: any): number | undefined {
        const r = e?.response;
        const body = typeof r?.data === "string" ? r.data : JSON.stringify(r?.data ?? "");
        const level = r?.status === 404 ? "info" : "error";
        logger[level](`${op}: ${e?.message} | status=${r?.status} | body=${body.replace(/\s+/g, " ").slice(0, 500)}`);
        return r?.status;
    }

    async getSalesOrder(salesOrder: string): Promise<SalesOrder | null> {
        const select = [
            "SalesOrder",
            "SalesOrderType",
            "SoldToParty",
            "CreationDate",
            "TotalNetAmount",
            "TransactionCurrency",
            "OverallSDProcessStatus",
            "OverallTotalDeliveryStatus",
            "TotalCreditCheckStatus",
            "DeliveryBlockReason",
            "HeaderBillingBlockReason",
        ].join(",");
        try {
            const data = await this.get<{ d: Record<string, string> }>(
                `${SRV.salesOrder}/A_SalesOrder(${lit(salesOrder)})?$select=${select}&$format=json`
            );
            const o = data.d;
            return {
                salesOrder: o.SalesOrder,
                customer: o.SoldToParty,
                orderType: o.SalesOrderType,
                creationDate: odataDate(o.CreationDate),
                netAmount: Number(o.TotalNetAmount),
                currency: o.TransactionCurrency,
                creditStatus: mapCreditStatus(o.TotalCreditCheckStatus),
                deliveryBlockReason: o.DeliveryBlockReason || undefined,
                deliveryBlockReasonText: deliveryBlockText(o.DeliveryBlockReason),
                billingBlockReason: o.HeaderBillingBlockReason || undefined,
                overallStatus: o.OverallSDProcessStatus,
                deliveryStatus: o.OverallTotalDeliveryStatus,
            };
        } catch (e: any) {
            // 404 = ordem nao existe (o corpo registrado distingue de "servico nao ativado").
            if (this.logError(`getSalesOrder ${salesOrder}`, e) === 404) return null;
            throw new Error(`Falha ao consultar a ordem no S/4HANA: ${e?.message ?? e}`);
        }
    }

    async getCustomerCredit(customer: string): Promise<CustomerCredit | null> {
        let accounts: any[];
        try {
            const data = await this.get<{ d: { results: any[] } }>(
                `${SRV.credit}/CreditManagementAccount?$filter=BusinessPartner%20eq%20${lit(customer)}&$format=json`
            );
            accounts = data.d.results ?? [];
        } catch (e: any) {
            this.logError(`getCustomerCredit ${customer}`, e);
            throw new Error(`Falha ao consultar o credito no S/4HANA: ${e?.message ?? e}`);
        }
        if (!accounts.length) return null; // cliente sem conta no Credit Management

        // Classe de risco (perfil do BP). Opcional: falha aqui nao impede a resposta.
        let riskClass: string | undefined;
        try {
            const bp = await this.get<{ d: Record<string, string> }>(
                `${SRV.credit}/CreditMgmtBusinessPartner(${lit(customer)})?$select=CreditRiskClass&$format=json`
            );
            riskClass = bp.d.CreditRiskClass || undefined;
        } catch (e) {
            this.logError(`getCustomerCredit risco ${customer}`, e);
        }

        // Mais de um segmento: usa o de maior limite (normalmente o segmento principal).
        const a = accounts.sort((x, y) => Number(y.CreditLimitAmount) - Number(x.CreditLimitAmount))[0];
        return {
            customer: a.BusinessPartner,
            creditSegment: a.CreditSegment,
            creditLimit: Number(a.CreditLimitAmount),
            currency: a.CreditSegmentCurrency,
            riskClass,
            accountBlocked: a.CreditAccountIsBlocked === true,
            accountBlockReason: a.CreditAccountBlockReason || undefined,
            note: "A API de credito do S/4HANA nao expoe a exposicao: use as faturas em aberto como referencia.",
        };
    }

    async getOpenInvoices(customer: string): Promise<OpenInvoice[]> {
        const select = [
            "AccountingDocument",
            "BillingDocument",
            "AccountingDocumentType",
            "DocumentDate",
            "NetDueDate",
            "AmountInTransactionCurrency",
            "TransactionCurrency",
        ].join(",");
        const filter = encodeURIComponent(
            `Customer eq '${customer.trim().replace(/'/g, "''")}' and IsCleared eq false and FinancialAccountType eq 'D'`
        );
        try {
            const data = await this.get<{ d: { results: any[] } }>(
                `${SRV.openItems}/A_OperationalAcctgDocItemCube?$filter=${filter}&$select=${select}` +
                    `&$orderby=NetDueDate%20asc&$top=${MAX_OPEN_ITEMS}&$format=json`
            );
            return (data.d.results ?? []).map((i): OpenInvoice => {
                const dueDate = odataDate(i.NetDueDate) ?? odataDate(i.DocumentDate) ?? "";
                const amount = Number(i.AmountInTransactionCurrency);
                return {
                    invoice: i.BillingDocument || i.AccountingDocument,
                    customer: customer.trim(),
                    amount,
                    currency: i.TransactionCurrency,
                    documentDate: odataDate(i.DocumentDate) ?? "",
                    dueDate,
                    // So debitos vencidos contam como atraso (creditos/pagamentos parciais tem valor negativo).
                    daysOverdue: dueDate && amount > 0 ? Math.max(0, daysBetween(dueDate)) : 0,
                    documentType: i.AccountingDocumentType,
                };
            });
        } catch (e: any) {
            this.logError(`getOpenInvoices ${customer}`, e);
            throw new Error(`Falha ao consultar as faturas no S/4HANA: ${e?.message ?? e}`);
        }
    }

    async releaseCreditBlock(salesOrder: string, justification: string): Promise<ReleaseResult> {
        if (process.env.S4_CREDIT_RELEASE !== "true") {
            return {
                salesOrder,
                released: false,
                message:
                    "Aprovacao registrada, mas a liberacao automatica esta desativada (S4_CREDIT_RELEASE). " +
                    `Libere no app "Release Blocked Documents" (ou VKM1). Justificativa: "${justification}".`,
            };
        }
        try {
            // Function import (POST). O Cloud SDK busca o X-CSRF-Token automaticamente.
            const res = await executeHttpRequest(
                { destinationName: this.destinationName },
                {
                    method: "POST",
                    url: `${SRV.creditBlock}/ReleaseCreditBlock?SalesDocument=${lit(salesOrder)}&SDDocumentCategory=${lit("C")}`,
                    headers: { Accept: "application/json" },
                },
                { fetchCsrfToken: true }
            );
            const sapMsg = res.headers?.["sap-message"];
            logger.info(`ReleaseCreditBlock ${salesOrder}: status=${res.status} sap-message=${sapMsg ?? "-"}`);
            return {
                salesOrder,
                released: true,
                message:
                    `Bloqueio de credito liberado no S/4HANA. Justificativa: "${justification}".` +
                    (sapMsg ? ` Mensagem do S/4: ${sapMsg}` : ""),
            };
        } catch (e: any) {
            this.logError(`releaseCreditBlock ${salesOrder}`, e);
            throw new Error(`Falha ao liberar o bloqueio no S/4HANA: ${e?.message ?? e}`);
        }
    }

    /** PATCH no cabecalho da ordem com If-Match (ETag lido antes) e X-CSRF-Token. */
    private async patchSalesOrder(salesOrder: string, body: Record<string, unknown>): Promise<void> {
        const url = `${SRV.salesOrder}/A_SalesOrder(${lit(salesOrder)})`;
        const head = await executeHttpRequest(
            { destinationName: this.destinationName },
            { method: "GET", url: `${url}?$select=SalesOrder&$format=json`, headers: { Accept: "application/json" } }
        );
        const etag = head.headers?.etag ?? (head.data as any)?.d?.__metadata?.etag ?? "*";
        await executeHttpRequest(
            { destinationName: this.destinationName },
            {
                method: "PATCH",
                url,
                headers: { Accept: "application/json", "Content-Type": "application/json", "If-Match": etag },
                data: body,
            },
            { fetchCsrfToken: true }
        );
    }

    /** Define (ou limpa, com "") o motivo de bloqueio de remessa. Usado pela liberacao e pelo reset da demo. */
    async setDeliveryBlock(salesOrder: string, reason: string): Promise<void> {
        try {
            await this.patchSalesOrder(salesOrder, { DeliveryBlockReason: reason });
            logger.info(`DeliveryBlockReason ${salesOrder} -> "${reason}"`);
        } catch (e: any) {
            this.logError(`setDeliveryBlock ${salesOrder}`, e);
            const sapMsg = e?.response?.data?.error?.message?.value;
            throw new Error(`Falha ao alterar o bloqueio de remessa no S/4HANA: ${sapMsg ?? e?.message ?? e}`);
        }
    }

    async releaseDeliveryBlock(salesOrder: string, justification: string): Promise<ReleaseResult> {
        if (process.env.S4_DELIVERY_RELEASE !== "true") {
            return {
                salesOrder,
                released: false,
                message:
                    "Aprovacao registrada, mas a liberacao automatica da remessa esta desativada (S4_DELIVERY_RELEASE). " +
                    `Retire o bloqueio de remessa na VA02. Justificativa: "${justification}".`,
            };
        }
        await this.setDeliveryBlock(salesOrder, "");
        return {
            salesOrder,
            released: true,
            message: `Bloqueio de remessa retirado no S/4HANA. Justificativa: "${justification}".`,
        };
    }
}
