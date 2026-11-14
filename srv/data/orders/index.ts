import { MockOrderManagementProvider } from "./mock";
import { S4OrderManagementProvider } from "./s4";
import type { OrderManagementProvider } from "./types";

let provider: OrderManagementProvider | undefined;

/**
 * Provider do agente de gestao de ordens. DATA_MODE=s4 ou hybrid usa o S/4HANA real
 * (o modo hybrid so simula o credito, que este agente nao usa); mock (padrao) usa dados ficticios.
 */
export function getOrderProvider(): OrderManagementProvider {
    if (!provider) {
        const mode = (process.env.DATA_MODE || "mock").toLowerCase();
        provider = mode === "s4" || mode === "hybrid" ? new S4OrderManagementProvider() : new MockOrderManagementProvider();
    }
    return provider;
}

export type * from "./types";
export { normalizeItem, normalizeOrder, REJECTION_REASONS } from "./types";
