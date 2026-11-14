#!/usr/bin/env bash
# Cria/atualiza a BTP Destination que liga a Joule ao agente (subaccount do CF logado).
# Uso: ./scripts/create-destination.sh [DESTINATION_NAME] [CF_APP_NAME] [CAMINHO_DO_AGENTE]
#   Agente de bloqueios (raiz):  ./scripts/create-destination.sh
#   Agente de gestao de ordens:  ./scripts/create-destination.sh SALES_ORDER_MGMT_A2A sales-order-agent-srv /order-management
# Pre-requisitos: cf login feito, app ja implantado (cf deploy), python3 e curl.
set -euo pipefail

DEST_NAME="${1:-SALES_ORDER_AGENT_A2A}"
APP_NAME="${2:-sales-order-agent-srv}"
AGENT_PATH="${3:-}"                       # ex.: /order-management (vazio = agente da raiz)
DEST_INSTANCE="destination-service"   # nome do resource no mta.yaml
KEY_NAME="sales-order-agent-dest-key"
XSUAA_INSTANCE="sales-order-agent-auth"   # resource xsuaa no mta.yaml
XSUAA_KEY_NAME="sales-order-agent-joule-key"

echo "[1/5] Descobrindo a URL do app ${APP_NAME}..."
GUID=$(cf app "$APP_NAME" --guid)
ROUTE=$(cf curl "/v3/apps/${GUID}/routes" | python3 -c "import json,sys; r=json.load(sys.stdin)['resources']; print(r[0]['url'] if r else '')")
[[ -z "$ROUTE" ]] && { echo "Nenhuma rota encontrada para ${APP_NAME}"; exit 1; }
AGENT_URL="https://${ROUTE}${AGENT_PATH}"
echo "      ${AGENT_URL}"

echo "[2/5] Obtendo credenciais do Destination Service (service key ${KEY_NAME})..."
cf create-service-key "$DEST_INSTANCE" "$KEY_NAME" >/dev/null 2>&1 || true
KEY_JSON=$(cf service-key "$DEST_INSTANCE" "$KEY_NAME" | sed -n '/^{/,$p')
read -r DEST_URI CLIENT_ID CLIENT_SECRET TOKEN_URL < <(python3 -c '
import json,sys
d=json.loads(sys.stdin.read()); c=d.get("credentials",d)
print(c["uri"], c["clientid"], c["clientsecret"], c["url"])' <<< "$KEY_JSON")

echo "[3/5] Autenticando..."
TOKEN=$(curl -s -X POST "${TOKEN_URL}/oauth/token" \
  -d grant_type=client_credentials --data-urlencode "client_id=${CLIENT_ID}" --data-urlencode "client_secret=${CLIENT_SECRET}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

echo "[4/5] Obtendo credenciais OAuth do XSUAA do agente (service key ${XSUAA_KEY_NAME})..."
cf create-service-key "$XSUAA_INSTANCE" "$XSUAA_KEY_NAME" >/dev/null 2>&1 || true
XSUAA_JSON=$(cf service-key "$XSUAA_INSTANCE" "$XSUAA_KEY_NAME" | sed -n '/^{/,$p')
read -r AGENT_CLIENT_ID AGENT_CLIENT_SECRET AGENT_TOKEN_URL < <(python3 -c '
import json,sys
d=json.loads(sys.stdin.read()); c=d.get("credentials",d)
print(c["clientid"], c["clientsecret"], c["url"] + "/oauth/token")' <<< "$XSUAA_JSON")
echo "      token: ${AGENT_TOKEN_URL}"

echo "[5/5] Criando/atualizando a destination ${DEST_NAME}..."
PAYLOAD=$(python3 -c '
import json,sys
n,u,ci,cs,tu,app=sys.argv[1:]
print(json.dumps({
  "Name": n, "Type": "HTTP", "URL": u, "ProxyType": "Internet",
  "Authentication": "OAuth2ClientCredentials",
  "clientId": ci, "clientSecret": cs, "tokenServiceURL": tu, "tokenServiceURLType": "Dedicated",
  "HTML5.DynamicDestination": "true", "WebIDEEnabled": "true",
  "Description": "A2A - Joule -> " + app + " (PoC SIT 2026, OAuth2 XSUAA)"
}))' "$DEST_NAME" "$AGENT_URL" "$AGENT_CLIENT_ID" "$AGENT_CLIENT_SECRET" "$AGENT_TOKEN_URL" "$APP_NAME")

API="${DEST_URI}/destination-configuration/v1/subaccountDestinations"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${API}/${DEST_NAME}")
METHOD=$([[ "$CODE" == "200" ]] && echo PUT || echo POST)
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X "$METHOD" -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" -d "$PAYLOAD" "$API")
[[ "$HTTP" =~ ^20 ]] || { echo "Falhou (HTTP ${HTTP})"; exit 1; }
echo "OK: ${METHOD} ${DEST_NAME} -> ${AGENT_URL}"
echo "Teste: curl ${AGENT_URL}/.well-known/agent.json"
echo "Teste A2A autenticado:"
echo "  XSUAA_TOKEN_URL=${AGENT_TOKEN_URL} XSUAA_CLIENT_ID=<clientid> XSUAA_CLIENT_SECRET=<secret> \\"
echo "  npx tsx scripts/simulate-joule.ts ${AGENT_URL}/"
echo "  (credenciais: cf service-key ${XSUAA_INSTANCE} ${XSUAA_KEY_NAME})"
