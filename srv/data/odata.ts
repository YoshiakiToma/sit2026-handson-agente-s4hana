/** Helpers OData V2 compartilhados pelos providers S/4HANA. */

/** Literal de string OData V2 (aspas simples escapadas e URL-encoded). */
export const lit = (v: string) => encodeURIComponent(`'${v.trim().replace(/'/g, "''")}'`);

/** Literal de string OData V2 sem URL-encode (para montar $filter que sera codificado inteiro). */
export const rawLit = (v: string) => `'${v.trim().replace(/'/g, "''")}'`;

/** Converte "/Date(1794009600000)/" do OData V2 em "AAAA-MM-DD". */
export const odataDate = (v?: string | null): string | undefined => {
    const ms = v ? /\/Date\((-?\d+)/.exec(v)?.[1] : undefined;
    return ms ? new Date(Number(ms)).toISOString().slice(0, 10) : undefined;
};

/** Converte "AAAA-MM-DD" no formato de corpo do OData V2 ("/Date(ms)/"). */
export const toODataDate = (iso: string): string => `/Date(${Date.parse(`${iso}T00:00:00Z`)})/`;

/** Literal datetime para $filter do OData V2: datetime'AAAA-MM-DDT00:00:00'. */
export const datetimeLit = (iso: string) => `datetime'${iso}T00:00:00'`;

/** Mensagem de erro do S/4 (error.message.value) quando houver. */
export const sapErrorMessage = (e: any): string | undefined => e?.response?.data?.error?.message?.value;
