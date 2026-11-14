import { MockProvider } from "./mock-provider";
import { S4Provider } from "./s4-provider";
import { HybridProvider } from "./hybrid-provider";
import type { DataProvider } from "./types";

let provider: DataProvider | undefined;

/**
 * DATA_MODE=mock (padrao) usa dados ficticios; DATA_MODE=s4 usa a BTP Destination S4_DESTINATION;
 * DATA_MODE=hybrid usa o S/4 real com o credito simulado (ver hybrid-provider.ts).
 */
export function getProvider(): DataProvider {
    if (!provider) {
        const mode = (process.env.DATA_MODE || "mock").toLowerCase();
        provider = mode === "s4" ? new S4Provider() : mode === "hybrid" ? new HybridProvider() : new MockProvider();
    }
    return provider;
}

export { HybridProvider };

export type * from "./types";
