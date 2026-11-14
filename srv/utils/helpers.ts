const VCAP = process.env.VCAP_APPLICATION;

/** URL publica do agente: rota do Cloud Foundry quando implantado, localhost em desenvolvimento. */
export const getA2aServerUrl = (): string =>
    VCAP ? `https://${JSON.parse(VCAP).application_uris[0]}/` : `http://localhost:${process.env.PORT || 4004}/`;

/** Extrai texto de um conteudo de mensagem LangChain (string ou lista de partes). */
export function contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && "text" in p ? String(p.text) : ""))
            .join("");
    }
    return "";
}
