import cds from "@sap/cds";
import type { NextFunction, Request, Response } from "express";
import type { User } from "@a2a-js/sdk/server";
import { XsuaaService, createSecurityContext } from "@sap/xssec";

const logger = cds.log("auth");

/** Escopos locais (sem o prefixo xsappname), definidos em xs-security.json. */
export const SCOPES = {
    invoke: "Agent.Invoke", // chamar o agente via A2A
    creditRelease: "CreditRelease", // liberar bloqueio de credito
    orderChange: "SalesOrder.Change", // criar, alterar e recusar itens de ordens (agente de gestao)
} as const;

/** Usuario autenticado repassado ao agente (ServerCallContext.user) e as tools (config.configurable.user). */
export class AgentUser implements User {
    constructor(
        readonly userName: string,
        readonly scopes: string[],
        readonly clientId?: string,
        readonly grantType?: string
    ) {}
    get isAuthenticated() {
        return true;
    }
    hasScope(scope: string) {
        return this.scopes.includes(scope);
    }
}

declare module "express-serve-static-core" {
    interface Request {
        agentUser?: AgentUser;
    }
}

const authKind = (): string => (cds.env.requires as any)?.auth?.kind ?? "dummy";
const isXsuaa = () => authKind() === "xsuaa";

let service: XsuaaService | undefined;
function getXsuaaService(): XsuaaService {
    if (!service) {
        const credentials = (cds.env.requires as any)?.auth?.credentials;
        if (!credentials?.xsappname) {
            throw new Error("auth.kind=xsuaa, mas nao ha credenciais XSUAA (faltou o binding da instancia xsuaa?)");
        }
        service = new XsuaaService(credentials);
    }
    return service;
}

/** URL do token XSUAA (para publicar no Agent Card), se houver binding. */
export function getTokenUrl(): string | undefined {
    const url = (cds.env.requires as any)?.auth?.credentials?.url;
    return url ? `${url}/oauth/token` : undefined;
}

const unauthorized = (res: Response, status: number, message: string) =>
    res
        .status(status)
        .set(status === 401 ? { "WWW-Authenticate": 'Bearer realm="sales-order-agent"' } : {})
        .json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } });

/**
 * Middleware do endpoint A2A: valida o JWT (XSUAA) e exige o escopo Agent.Invoke.
 * Sem binding XSUAA (auth.kind dummy/mocked, desenvolvimento local), cria um usuario local com todos os escopos.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
    if (!isXsuaa()) {
        req.agentUser = new AgentUser("local-dev", Object.values(SCOPES));
        return next();
    }

    const header = req.headers.authorization ?? "";
    const jwt = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    if (!jwt) return unauthorized(res, 401, "Token ausente: envie Authorization: Bearer <JWT XSUAA>");

    try {
        const ctx: any = await createSecurityContext(getXsuaaService(), { jwt });
        const xsappname = (getXsuaaService().credentials as any).xsappname as string;
        const prefix = `${xsappname}.`;
        const scopes = ((ctx.token?.scopes as string[]) ?? [])
            .filter((s) => s.startsWith(prefix))
            .map((s) => s.slice(prefix.length));
        const grantType = ctx.getGrantType?.();
        const clientId = ctx.getClientId?.();
        const userName =
            grantType === "client_credentials" ? `client:${clientId}` : ctx.getLogonName?.() || `client:${clientId}`;

        const user = new AgentUser(userName, scopes, clientId, grantType);
        if (!user.hasScope(SCOPES.invoke)) {
            logger.warn(`acesso negado para ${userName}: falta o escopo ${SCOPES.invoke}`);
            return unauthorized(res, 403, `Escopo ${SCOPES.invoke} necessario`);
        }
        req.agentUser = user;
        next();
    } catch (e: any) {
        logger.warn("token invalido:", e?.message ?? e);
        return unauthorized(res, e?.statusCode === 403 ? 403 : 401, "Token invalido ou expirado");
    }
}

/** UserBuilder do SDK A2A: entrega ao AgentExecutor o usuario validado pelo middleware. */
export const userBuilder = async (req: Request): Promise<User> => {
    if (!req.agentUser) throw new Error("Requisicao sem usuario autenticado");
    return req.agentUser;
};
