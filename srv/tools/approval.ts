import type { AgentUser } from "../auth";

/** Respostas que contam como "sim" na confirmacao humana (texto livre ou botao da Joule). */
export const APPROVAL = /^\s*(sim|s|yes|y|ok|aprovo|aprovado|confirmo|confirmado|pode)\b/i;

/** Usuario autenticado repassado as tools pelo executor (config.configurable.user). */
export const userOf = (config: any) => config?.configurable?.user as AgentUser | undefined;

export const hasScope = (config: any, scope: string) => userOf(config)?.hasScope?.(scope) === true;
