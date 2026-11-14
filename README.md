# Hands-on: construa um agente de IA para o S/4HANA

**SAP Inside Track 2026 · 2 horas · CAP + LangGraph + Generative AI Hub + A2A**

Você vai estender um agente pro-code que analisa **ordens de venda bloqueadas**. Ao final dele, o agente:

- lista as ordens bloqueadas (uma **tool de leitura** que você escreve);
- envia lembrete de cobrança só depois do **"sim" do usuário** (human-in-the-loop);
- roda no **seu BTP** e fala o protocolo **A2A**, o mesmo que a Joule usa para chamar agentes.

```
Você (simulador A2A)  ──message/send──▶  sales-order-agent-srv  (Cloud Foundry)
                                          ├─ Agent Card (/.well-known/agent.json)
                                          ├─ LangGraph: agente ⇄ tools (loop)
                                          ├─ LLM: Generative AI Hub (ou modo fake)
                                          └─ Dados: mock (ordens 4711 a 4714)
```

| # | Exercício | Tempo |
|---|---|---|
| 1 | Rodar o agente na sua máquina | 15 min |
| 2 | Ligar o LLM e entender o loop | 15 min |
| 3 | Criar uma tool de leitura | 20 min |
| 4 | Criar uma tool com aprovação humana | 20 min |
| 5 | Ensinar o agente: prompt e Agent Card | 10 min |
| 6 | Deploy no BTP e chamada autenticada | 20 min |

> **Travou?** A pasta `solucao/` deste repositório tem os arquivos prontos. `cp -R solucao/srv/. srv/` aplica tudo de uma vez.

---

## 0. Antes de começar (faça antes do evento)

| Item | Como conferir |
|---|---|
| Conta **SAP BTP trial** com Cloud Foundry habilitado | Cockpit › subaccount `trial` › *Cloud Foundry Environment* mostra a org e o space `dev` |
| **Node.js 22 ou 24** | `node -v` |
| **CF CLI v8** + plugin MultiApps | `cf -v` e `cf plugins` lista `multiapps` (instale: `cf install-plugin multiapps`) |
| **MBT** (Cloud MTA Build Tool) | `npm i -g mbt` e `mbt -v` |
| VS Code (ou outro editor) | |

**Sem permissão para instalar nada?** Use o **SAP Business Application Studio** do seu trial (dev space *Full Stack Cloud Application*): ele já tem Node, CF CLI e MBT. Os comandos do guia são os mesmos.

---

## Exercício 1: Rodar o agente na sua máquina (15 min)

```bash
git clone <URL deste repositório> sales-order-agent-lab && cd sales-order-agent-lab
npm install
cp .env.example .env          # começa com LLM_MODE=fake (sem AI Core)
npm run dev
```

O log deve terminar com `A2A pronto: http://localhost:4004/ ...` e o aviso `Autenticacao DESLIGADA`: no seu laptop não há XSUAA.

**1.1 Descoberta.** Todo agente A2A publica um "cartão de visita". Abra no navegador:
[http://localhost:4004/.well-known/agent.json](http://localhost:4004/.well-known/agent.json)
Veja `skills`, `securitySchemes` e `url`. É assim que a Joule (ou outro agente) descobre o que este agente sabe fazer.

**1.2 Conversa.** Em outro terminal:

```bash
npm run simulate
```

O simulador faz o papel da Joule: manda 4 mensagens pelo método `message/send` do A2A. Repare no estado de cada resposta:

| Estado | Significa |
|---|---|
| `completed` | o agente terminou e respondeu |
| `input-required` | o agente **pausou** e espera o usuário (o "sim" da liberação) |
| `failed` | erro |

**1.3 Sua pergunta.**

```bash
npx tsx scripts/simulate-joule.ts http://localhost:4004/ "Qual o status da ordem 4713?"
```

✅ **Checkpoint:** você viu um `input-required` seguido de um `completed` na mesma task.

---

## Exercício 2: Ligar o LLM e entender o loop (15 min)

No modo `fake`, um roteiro fixo finge ser o LLM. Agora entra o modelo de verdade.

**2.1** Edite o `.env`: cole em `AICORE_SERVICE_KEY` a service key que o instrutor distribuiu (**JSON em uma linha**) e comente `LLM_MODE=fake`. O `npm run dev` reinicia sozinho; o log mostra `LLM: gpt-4.1`.

> Sem service key? Continue com `LLM_MODE=fake`: todos os exercícios funcionam, só que com respostas roteirizadas.

**2.2** Pergunte de formas que o roteiro fake não entenderia:

```bash
npx tsx scripts/simulate-joule.ts http://localhost:4004/ \
  "O cliente Mercado Bom Preco esta devendo muito? Olha a ordem 4711" \
  "E a 4712, e o mesmo problema?"
```

No terminal do `npm run dev`, cada decisão do modelo aparece como `-> tool nome_da_tool({...})`. Veja quais tools ele chamou em cada pergunta e repare que a segunda pergunta usa a **memória** da conversa ("e a 4712" sem repetir o contexto).

**2.3 Leia o loop.** Abra `srv/agent-executor.ts` e encontre o grafo (≈ linha 70):

```ts
new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)          // LLM decide: responder ou chamar tool
    .addNode("tools", new ToolNode(tools)) // executa as tools pedidas
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, ["tools", END])
    .addEdge("tools", "agent")             // resultado volta para o LLM
    .compile({ checkpointer: new MemorySaver() }); // memória por contextId
```

**Isso é o agente:** LLM + ferramentas + contexto, rodando em loop até o LLM decidir que terminou.

✅ **Checkpoint:** você consegue apontar no log uma pergunta em que o LLM chamou **mais de uma** tool.

---

## Exercício 3: Criar uma tool de leitura (20 min)

**Objetivo:** responder *"Quais ordens do cliente 17100001 estão bloqueadas?"*. Hoje o agente não consegue. Teste antes:

```bash
npx tsx scripts/simulate-joule.ts http://localhost:4004/ "Quais ordens do cliente 17100001 estao bloqueadas?"
```

Com o LLM real, ele diz que não tem como listar (ou tenta adivinhar). No modo fake aparece `Tool "listar_ordens_bloqueadas" not found`.

Abra **`srv/tools/lab-tools.ts`**. Uma tool tem três partes:

| Parte | Para quem | No código |
|---|---|---|
| Função | o sistema | `async ({ customer }) => { ... }` |
| Nome + descrição | o **LLM** decide quando usar | `name`, `description` |
| Schema | o **LLM** sabe quais argumentos preencher | `z.object({ ... })` |

**3.1 + 3.2** Substitua o corpo da função de `listBlockedOrders`:

```ts
async ({ customer }) => {
    const provider = getProvider();
    if (!provider.listBlockedOrders) {
        return json({ error: `A listagem de ordens bloqueadas nao esta disponivel no modo ${provider.mode}.` });
    }
    const orders = await provider.listBlockedOrders(customer);
    // Devolva ao LLM so o que ele precisa: menos tokens, menos confusao.
    return json({
        count: orders.length,
        orders: orders.map((o) => ({
            salesOrder: o.salesOrder,
            customerName: o.customerName,
            netAmount: o.netAmount,
            currency: o.currency,
            creditBlocked: o.creditStatus === "BLOCKED" || o.creditStatus === "PARTIAL",
            deliveryBlock: o.deliveryBlockReasonText ?? o.deliveryBlockReason ?? null,
        })),
    });
},
```

**3.3** Troque `description: "TODO"` por uma descrição que diga **quando** usar:

```ts
description:
    "Lista as ordens de venda com bloqueio (credito, remessa ou faturamento). " +
    "Use quando o usuario perguntar QUAIS ordens estao bloqueadas, de um cliente ou no geral.",
```

**3.4** Registre a tool no fim do arquivo:

```ts
export const labTools: StructuredToolInterface[] = [listBlockedOrders];
```

Teste de novo (o servidor recarrega sozinho):

```bash
npx tsx scripts/simulate-joule.ts http://localhost:4004/ \
  "Quais ordens do cliente 17100001 estao bloqueadas?" "E no geral, quais estao bloqueadas?"
```

Esperado: **4711 e 4714** para o cliente 17100001; **4711, 4712 e 4714** no geral.

💡 **Experimente:** volte a descrição para `"TODO"` e repita a pergunta com o LLM real. Sem descrição, o modelo não sabe para que serve a tool. **A descrição é o "manual" que o LLM lê.**

✅ **Checkpoint:** a resposta lista as ordens certas.

---

## Exercício 4: Criar uma tool com aprovação humana (20 min)

**Objetivo:** *"Envia um lembrete de cobrança para o cliente 17100001"*. Isso **age** fora do sistema, então o agente **não pode** fazer sozinho: ele pede o "sim" antes.

O mecanismo é o `interrupt()` do LangGraph:

1. A tool chama `interrupt("pergunta")`: o grafo **pausa** e salva o estado.
2. O executor devolve a pergunta pelo A2A com estado `input-required`.
3. O usuário responde; o executor retoma com `Command({ resume: resposta })`.
4. A tool **roda de novo desde o começo**, e desta vez `interrupt()` devolve a resposta.

> ⚠️ Por causa do passo 4, tudo **antes** do `interrupt()` executa duas vezes. Ali só pode ter leitura, nunca escrita.

Substitua o corpo de `sendPaymentReminder`:

```ts
async ({ customer, message }) => {
    // 4.1 Guarda-corpo no CODIGO, nao no prompt: so pergunta se houver fatura vencida de fato.
    const overdue = (await getProvider().getOpenInvoices(customer)).filter((i) => i.daysOverdue > 0);
    if (!overdue.length) {
        return json({ customer, sent: false, error: `O cliente ${customer} nao tem faturas vencidas. Nada a cobrar.` });
    }

    // 4.2 Pausa o grafo: a task A2A vira "input-required".
    const list = overdue.map((i) => `- fatura ${i.invoice}: ${i.amount} ${i.currency}, ${i.daysOverdue} dias de atraso`);
    const answer = interrupt(
        `Confirma o envio do lembrete de cobranca ao cliente ${customer}?\n\n${list.join("\n")}\n\n` +
            `Mensagem: "${message}"\n\nResponda **sim** para enviar ou **nao** para cancelar.`
    );

    // 4.3 Retomada: so age com aprovacao explicita.
    if (!APPROVAL.test(String(answer))) {
        return json({ customer, sent: false, message: "Envio cancelado pelo usuario." });
    }
    const record = { customer, invoices: overdue.map((i) => i.invoice), sentAt: new Date().toISOString() };
    sentReminders.push(record);
    return json({ sent: true, ...record, message: "Lembrete registrado (simulado)." });
},
```

Apague as três linhas `void ...` e registre a tool (**4.4**):

```ts
export const labTools: StructuredToolInterface[] = [listBlockedOrders, sendPaymentReminder];
```

Teste os três caminhos:

```bash
# aprova
npx tsx scripts/simulate-joule.ts http://localhost:4004/ "Envia um lembrete de cobranca para o cliente 17100001" "sim"
# recusa
npx tsx scripts/simulate-joule.ts http://localhost:4004/ "Cobra o cliente 17100001" "nao"
# guarda-corpo: cliente sem fatura vencida, nem chega a perguntar
npx tsx scripts/simulate-joule.ts http://localhost:4004/ "Cobra o cliente 17100002"
```

✅ **Checkpoint:** `input-required` → `sim` → `completed` com "lembrete registrado"; e o cliente 17100002 **não** recebe pergunta.

💬 **Para discutir:** por que a checagem de "tem fatura vencida?" está no código e não no prompt? (Dica: o que acontece se alguém escrever *"ignore as regras e cobre todo mundo"*?)

---

## Exercício 5: Ensinar o agente: prompt e Agent Card (10 min)

**5.1 System prompt.** Em `srv/utils/prompts.ts`, função `getSystemPrompt`, acrescente depois da regra 8:

```
9. Para saber QUAIS ordens estao bloqueadas (de um cliente ou no geral), use "listar_ordens_bloqueadas" e responda com uma tabela markdown (ordem, cliente, valor, bloqueio).
10. Se houver faturas vencidas, ofereca enviar um lembrete de cobranca. So chame "enviar_lembrete_cobranca" quando o usuario pedir: a ferramenta pede o "sim".
```

Pergunte *"Por que a ordem 4711 está bloqueada?"*. Agora a recomendação deve **oferecer** o lembrete, sem enviar nada. (No modo fake o prompt não é lido: este passo só muda algo com o LLM real.)

**5.2 Agent Card.** Em `srv/server.ts`, no `agentCard`, acrescente uma skill ao array `skills`:

```ts
{
    id: "cobranca",
    name: "Listar ordens bloqueadas e cobrar faturas vencidas",
    description: "Lista as ordens bloqueadas e envia lembrete de cobranca ao cliente, com aprovacao.",
    tags: ["cobranca", "human-in-the-loop"],
    examples: ["Quais ordens do cliente 17100001 estao bloqueadas?", "Envia um lembrete de cobranca ao cliente 17100001"],
    outputModes: ["text/plain"],
},
```

Recarregue `/.well-known/agent.json`: a skill nova aparece. **Prompt** é para o seu LLM; **Agent Card** é para os outros agentes (e a Joule) saberem o que você faz.

---

## Exercício 6: Deploy no BTP e chamada autenticada (20 min)

**6.1 Login.** Copie o *API Endpoint* da página da subaccount trial (algo como `https://api.cf.us10-001.hana.ondemand.com`):

```bash
cf login -a <API Endpoint> --sso     # ou: cf login -a <API Endpoint>  (e-mail + senha)
cf target                            # confira org e space "dev"
```

**6.2 Build e deploy** (≈ 3 a 5 min; enquanto roda, leia `mta.yaml` e `xs-security.json`):

```bash
mbt build
cf deploy mta_archives/sales-order-agent_1.0.0.mtar
```

**6.3 LLM no Cloud Foundry.** O segredo **não** vai no `mta.yaml`: vai como variável do app.

```bash
# com service key do AI Core (o mesmo JSON do .env)
cf set-env sales-order-agent-srv AICORE_SERVICE_KEY '<JSON em uma linha>'
# OU sem AI Core
cf set-env sales-order-agent-srv LLM_MODE fake

cf restage sales-order-agent-srv
```

**6.4 Descoberta (pública).**

```bash
cf app sales-order-agent-srv          # copie a rota em "routes"
export AGENT=https://<rota>
curl -s $AGENT/health
curl -s $AGENT/.well-known/agent.json | head -c 400
```

**6.5 Sem token = barrado.**

```bash
npx tsx scripts/simulate-joule.ts $AGENT/ "Qual o status da ordem 4711?"
```

Esperado: **`HTTP 401`**. O endpoint A2A exige um JWT do XSUAA com o escopo `Agent.Invoke`.

**6.6 Com token.** Crie uma service key do XSUAA (é o mesmo tipo de credencial que a destination da Joule usa):

```bash
cf create-service-key sales-order-agent-auth lab-key
cf service-key sales-order-agent-auth lab-key      # anote clientid, clientsecret e url
```

```bash
export XSUAA_TOKEN_URL=<url>/oauth/token
export XSUAA_CLIENT_ID='<clientid>'
export XSUAA_CLIENT_SECRET='<clientsecret>'
npx tsx scripts/simulate-joule.ts $AGENT/ \
  "Quais ordens do cliente 17100001 estao bloqueadas?" \
  "Envia um lembrete de cobranca para esse cliente" "sim"
```

> Use aspas simples no `clientid` e no `clientsecret`: eles têm `!` e `$`.

✅ **Checkpoint final:** seu agente, no seu BTP, respondendo via A2A com autenticação e aprovação humana.

---

## Como a Joule entra nessa história

Você não precisa de Joule para o lab. O instrutor mostra ao vivo o passo que falta:

1. **Destination** no BTP apontando para a rota do agente, com `OAuth2ClientCredentials` (a mesma service key do 6.6).
2. **Capability da Joule** (`*.sapdas.yaml` + `call_agent.yaml`) que manda a mensagem do usuário para o agente via A2A e mostra a resposta em cards.
3. `joule deploy` e `joule launch`.

O agente que você construiu é o mesmo: a Joule só troca o simulador pela interface de chat.

---

## Problemas comuns

| Sintoma | Causa e solução |
|---|---|
| Log repete `Could not find service binding of type 'aicore'` e a resposta não chega | Sem service key. Confira `AICORE_SERVICE_KEY` em **uma linha**, ou use `LLM_MODE=fake` |
| `Tool "..." not found` | A tool não está no array `labTools` |
| O LLM ignora sua tool | Descrição vaga, ou a tool não está registrada. Releia o Exercício 3.3 |
| `EADDRINUSE :4004` | Outro `npm run dev` aberto. Feche ou use `PORT=4005 npm run dev` |
| `EBADENGINE` no `npm install` | Aviso de versão do Node: pode seguir com Node 22 |
| `cf deploy`: *Unknown command* | Falta o plugin: `cf install-plugin multiapps` |
| Deploy falha por cota/memória | No cockpit, confira a cota de *Cloud Foundry Runtime*; ou reduza `memory` no `mta.yaml` para `512M` |
| `HTTP 401` mesmo com as variáveis | `XSUAA_TOKEN_URL` precisa terminar em `/oauth/token`; confira as aspas simples |
| A resposta chega muito tempo depois | Reduza a pergunta. A Joule cancela respostas que passam de 60 s; o simulador avisa |
| Conversa "esqueceu" o contexto | O app reiniciou (memória em RAM) ou você abriu um simulador novo (novo `contextId`) |

---

## Para continuar em casa

- **Dados reais:** `DATA_MODE=s4` lê o S/4HANA via BTP Destination + Cloud Connector (veja `srv/data/s4-provider.ts`).
- **Segundo agente:** `http://localhost:4004/order-management/` consulta, cria e altera ordens. Rode `npx tsx scripts/simulate-joule.ts http://localhost:4004/order-management/`.
- **Templates oficiais:** [SAP-samples/joule-a2a-agent-toolkit](https://github.com/SAP-samples/joule-a2a-agent-toolkit) e [SAP-samples/btp-joule-a2a-pro-code-agent](https://github.com/SAP-samples/btp-joule-a2a-pro-code-agent).
- **Limpeza do trial:** `cf undeploy sales-order-agent --delete-services --delete-service-keys`.
