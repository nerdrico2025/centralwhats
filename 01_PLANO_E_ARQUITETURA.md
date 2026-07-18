# Plano & Arquitetura — Plataforma de Gestão de WhatsApp (WA Manager)

> Documento mestre do projeto. Serve como "estrela guia" para todo o desenvolvimento.
> Baseado no PRD de referência (sistema em produção com lições reais) + requisitos novos:
> Baileys (API não-oficial), multi-tenancy e app mobile (APK).
>
> Ordem de leitura sugerida: este arquivo → `CLAUDE.md` → `02_PROMPTS_CURSOR_CLAUDE_CODE.md`.

---

## 1. Visão do produto

Um painel web para gerenciar números de WhatsApp Business: enviar mensagens (texto, mídia,
templates, interativos), conversar em tempo real (Live Chat), organizar contatos (tags/CRM/listas),
disparar campanhas em massa e construir chatbots visuais (fluxos automatizados) sem código.

**Duas gerações do produto:**

- **V1 — Uso próprio, API Oficial (Meta Cloud API).** Um ou mais números conectados via API oficial.
  Webhook-driven, roda bem em serverless. É a fundação.
- **V2 — SaaS multi-tenant + Baileys + Mobile.** Vários negócios (tenants) com dados isolados,
  conexão de número via Baileys (API não-oficial, conecta lendo QR code), e um app mobile
  simplificado (APK) só para ler/responder conversas.

O ponto central de todo o design: **o que muda entre V1 e V2 deve ser um adaptador, não uma
reescrita.** Duas abstrações fazem isso acontecer e precisam existir desde o primeiro commit
(detalhadas na seção 4).

---

## 2. Decisão arquitetural crítica (Baileys × serverless)

O PRD de referência recomenda Vercel serverless puro. Isso é **correto para a V1** (API oficial é
100% webhook + request/response) mas **quebra na V2** por um motivo concreto:

- A **API Oficial** empurra mensagens pra você via webhook HTTP. Você não mantém conexão viva —
  a Meta te chama. Serverless é perfeito.
- O **Baileys** funciona ao contrário: ele mantém um **WebSocket permanente** com o WhatsApp Web,
  por número conectado. Se o processo morre, a sessão cai e o número desconecta. Serverless mata
  o processo depois de cada request → **incompatível por natureza**.

### A resolução (arquitetura híbrida, decidida agora, implementada aos poucos)

```
┌─────────────────────────────────────────────────────────────┐
│  CAMADA WEB / API  (serverless-friendly — Vercel/etc.)       │
│  - SPA (frontend)                                            │
│  - REST API (instâncias, contatos, campanhas, fluxos...)    │
│  - Webhook receiver da API Oficial                          │
│  - processPendingExecutions (retomada de delays)            │
└───────────────┬─────────────────────────┬───────────────────┘
                │                         │
                │   (mesmo Postgres)      │
                ▼                         ▼
        ┌───────────────┐        ┌─────────────────────────────┐
        │   POSTGRES    │◄───────┤  WORKER BAILEYS (V2)         │
        │  (Supabase)   │        │  processo SEMPRE-LIGADO      │
        │               │        │  (Railway / Fly / VPS)       │
        └───────────────┘        │  - mantém 1 socket por       │
                                 │    número conectado          │
                                 │  - grava inbound no mesmo DB │
                                 │  - lê "outbox" pra enviar    │
                                 └─────────────────────────────┘
```

**Regras da híbrida:**

- V1 não precisa do worker Baileys. Fica só a camada web serverless + Postgres. Barato e simples.
- Todo o **motor de fluxos** e a **camada de dados** são módulos puros, chamáveis tanto pela camada
  web quanto pelo worker. Nada de lógica de negócio presa dentro de um handler HTTP.
- O worker Baileys **não fala HTTP com o resto do sistema** para operar; ele compartilha o mesmo
  Postgres. Envio de saída via Baileys pode ser feito por uma tabela `outbox` (a camada web insere
  a intenção de envio, o worker consome) OU por chamada direta ao provider dentro do worker quando
  o gatilho já está no worker (mensagem recebida via Baileys). Preferir o padrão `outbox` para
  disparos em massa/campanhas iniciados pela web.

> **Recomendação prática:** V1 em Vercel + Supabase. Quando a V2 chegar, sobe UM serviço worker
> (Railway/Fly/VPS pequeno) que aponta pro mesmo Supabase. Você não migra nada — só adiciona.

---

## 3. Stack técnica

| Camada        | Escolha                                   | Observação |
|---------------|-------------------------------------------|------------|
| Backend       | Node.js + Express (ou Hono)               | TypeScript recomendado |
| Banco (prod)  | Postgres via Supabase                     | Acesso sempre via camada `repo.*` |
| Banco (dev)   | SQLite                                     | Mesmo `repo.*`, adapter diferente |
| Frontend      | SPA (Vanilla JS ou framework leve — Preact/Svelte) | Servido como estático |
| Deploy web    | Vercel (serverless) ou equivalente        | Sem processo de longa duração aqui |
| Worker (V2)   | Node sempre-ligado — Railway/Fly/VPS      | Só existe quando Baileys entrar |
| Integração V1 | Meta WhatsApp Cloud API (Graph API)       | Mensagens, templates, webhooks |
| Integração V2 | Baileys (`@whiskeysockets/baileys`)       | Sessão persistida no DB/storage |
| Mobile (V2)   | Expo / React Native (gera APK)            | Cliente fino sobre a mesma REST API |
| Auth (V2)     | Supabase Auth ou JWT próprio              | Escopo por `org_id` |

**Por que TypeScript:** os erros mais caros do PRD (concorrência, estados esquecidos, IDs de nó
perdidos) são exatamente os que tipos ajudam a pegar cedo. Vale o custo.

---

## 4. As duas abstrações que salvam a V2

### 4.1 Camada de dados (`repo.*`) — já pedida no PRD

Toda leitura/escrita passa por uma interface comum, com adapters intercambiáveis:

```
repo.instances, repo.messages, repo.contacts, repo.templates,
repo.tags, repo.crm, repo.lists, repo.campaigns,
repo.flows, repo.flowExecutions, repo.flowNodeCounters
(V2) repo.orgs, repo.users, repo.outbox
```

Dois adapters: `SqliteAdapter` (dev) e `PostgresAdapter` (prod). Nenhum lugar do código fala SQL
cru fora do adapter. Trocar de banco = trocar uma linha de config.

### 4.2 Camada de provider (`provider.*`) — a chave da V2

**Esta é a abstração que o PRD não tem e que o seu projeto precisa.** Todo envio de mensagem passa
por uma interface única, independente de ser API oficial ou Baileys:

```
provider.sendText(instance, to, text)
provider.sendMedia(instance, to, media)
provider.sendTemplate(instance, to, template, vars)   // só faz sentido na oficial
provider.sendButtons(instance, to, ...)
provider.sendList(instance, to, ...)
provider.sendReaction(instance, to, messageId, emoji)
```

Duas implementações:
- `MetaCloudProvider` (V1) — chama a Graph API.
- `BaileysProvider` (V2) — chama o socket Baileys (via worker/outbox).

O motor de fluxos, o de campanhas e o Live Chat **nunca sabem qual provider está em uso** — só
chamam `provider.sendX()`. Cada instância guarda seu `provider_type` (`meta` | `baileys`) e o
dispatcher escolhe a implementação. Assim, ligar Baileys na V2 = escrever um adapter, não mexer no
resto.

> Diferenças que a abstração precisa tratar honestamente: templates/HSM só existem na oficial;
> a janela de 24h e regras de opt-in são da oficial; interativos (botões/listas) têm suporte e
> formatos diferentes no Baileys. O provider expõe capacidades (`provider.capabilities`) para a UI
> esconder o que aquele tipo de instância não suporta, em vez de falhar silenciosamente.

---

## 5. Módulos (o quê construir)

Herdados do PRD, na ordem de dependência:

1. **Instâncias (multi-WABA / multi-número).** `phone_number_id`, `waba_id`, token, `verify_token`,
   `provider_type`. Webhook identifica a instância pelo `phone_number_id` do payload, não pela URL.
2. **Envio de mensagens.** Todos os tipos, sempre via `provider.*`.
3. **Webhook de recebimento.** Grava inbound, atualiza `last_seen`, cria/atualiza CRM; grava status
   (sent/delivered/read/**failed com o motivo do erro**). Resposta HTTP imediata; processamento
   pesado em background.
4. **Templates.** Sincroniza da Meta. **Idioma cadastrado na Meta é a fonte da verdade** — usar o
   idioma exato registrado, nunca assumir `pt_BR`.
5. **Live Chat.** Lista de conversas, view por contato, composer. **`grid-template-rows` explícito**
   no layout da conversa (bug que reapareceu 2x no projeto de referência).
6. **Contatos, Tags, CRM.** Telefone normalizado, nome do `profile.name` (**com plano B** quando a
   Meta não compartilha por privacidade).
7. **Listas & Campanhas.** Segmentação + template + variáveis por contato, com acompanhamento.
8. **Disparo em massa.** O módulo mais sensível (ver seção 7).
9. **Fluxos / Chatbot builder.** O motor de automação (ver seção 8).
10. **(V2) Multi-tenancy, Baileys, Mobile.**

---

## 6. Modelo de dados

Tabelas essenciais (do PRD), com acréscimos para V2 marcados `[V2]`:

```
instances        (id, [V2 org_id], name, provider_type[meta|baileys],
                  phone_number_id, waba_id, token, verify_token, active,
                  [V2 baileys_session_ref], connection_status)
messages         (id, instance_id, direction[in/out], from_number, to_number, type,
                  content, status, error_code, error_message, wa_message_id, campaign_id,
                  created_at)
contacts         (id, instance_id, phone, name, last_seen)
templates        (id, instance_id, name, category, language, status, components,
                  wa_template_id)
tags             (id, instance_id, name, color)
contact_tags     (contact_id, tag_id)
crm_contacts     (id, instance_id, contact_id, phone, name, stage, score, custom_fields)
contact_lists    (id, instance_id, name)
list_contacts    (list_id, contact_id)
campaigns        (id, instance_id, name, template_id, sent_count, failed_count,
                  total_recipients, interval_ms, status, created_at)
campaign_sends   (id, campaign_id, contact_phone, status, error_code, error_message, sent_at)
flows            (id, instance_id, name, trigger_keywords, nodes[json], edges[json], active)
flow_executions  (id, flow_id, instance_id, contact_phone, current_node_id, status
                  [running|waiting_input|completed|cancelled], variables[json], next_step_at,
                  updated_at)
flow_node_counters (flow_id, node_id, counter)   -- round-robin do Randomizador (atômico)

[V2] orgs        (id, name, plan, created_at)
[V2] users       (id, org_id, email, role[owner|agent], password_hash)
[V2] outbox      (id, instance_id, to_number, payload[json], status[pending|sent|failed],
                  error, created_at, sent_at)   -- ponte web→worker Baileys
```

Notas:
- `campaign_sends` é a materialização da lição "logue TODO envio, sucesso ou falha". Nunca "só grava
  se deu certo".
- `error_code` / `error_message` em `messages` guardam o `errors[].code`/`errors[].message` do
  payload de status "failed" da Meta. Não descarte.
- Toda query é escopada por `instance_id` (e por `org_id` na V2). Nunca cross-instância sem intenção
  explícita.

---

## 7. Disparo em massa — regras de produção (não negociáveis)

Do PRD, codificadas para o motor de disparo:

- **Logue o resultado de cada envio** (sucesso E falha), com motivo do erro, em `campaign_sends`.
  O padrão "só grava se deu certo" é proibido (o projeto de referência perdeu ~100 de 160 envios
  por isso).
- **`Promise.allSettled`, nunca `Promise.all`** num lote. Uma falha isolada não pode apagar o rastro
  dos que deram certo.
- **Intervalo configurável entre envios** na UI — o operador escolhe, não fixe um valor. Rate
  limiting é decisão de negócio.
- **Sem paralelismo agressivo por padrão.** Teste real do projeto de referência: lotes de 3 em
  paralelo **não** reduziram o intervalo real — o teto de throughput é por número, do lado da Meta.
  Rajadas agressivas também degradam a reputação do número.
- **Retry automático só em erro de rate-limit** (ex.: códigos `130429` / `131056`), com espera antes
  de tentar de novo. **Sem retry** para erros permanentes (número inválido não melhora tentando de
  novo).
- Campanha grande **não roda numa única request** (serverless tem timeout). Processa em lotes
  retomáveis: a campanha tem estado no banco (`sent_count`, cursor de progresso), e cada "tick"
  processa um lote e reagenda o próximo — mesmo mecanismo de retomada dos fluxos.

---

## 8. Motor de fluxos — as lições mais caras do projeto

O chatbot builder é o coração e a maior fonte de bugs. Estas regras vêm de bugs reais e são o
"teste de fogo" do projeto. **Todas viram regras no `CLAUDE.md`.**

### 8.1 Nós
Início, Mensagem, Mídia, Botões, Lista, **Aguardar (delay)**, Tag, **Randomizador**, Condição,
**Aguardar Resposta**, Webhook, Fim.

### 8.2 Máquina de estados
Cada execução: `status`, `current_node_id`, `variables` (dict livre), `next_step_at` (retomadas).

### 8.3 Concorrência no nó "Aguardar" — a lição nº 1
**Nunca** `await sleep(segundos)` dentro do processo achando que `waitUntil` mantém a function viva.
Sob concorrência real (campanha, não teste solo), o serverless recicla o processo no meio do sleep e
a execução **trava pra sempre, sem erro** (aconteceu: 54 execuções presas de uma vez).

**Jeito certo:**
1. Ao entrar no delay, **resolver a próxima aresta já**, gravar `current_node_id` apontando pro
   próximo nó, `next_step_at = agora + segundos`, e **retornar sem esperar**.
2. `processPendingExecutions()` varre execuções com `next_step_at` vencido e as retoma.
3. **Sem depender de cron externo por padrão:** todo webhook que chega dispara a varredura em
   background para aquela instância. Cron externo fica como reforço opcional para instâncias muito
   paradas (fora de escopo v1, ver seção 10).

### 8.4 Delay híbrido por duração — a lição nº 2
Nem todo delay é igual. Delay curto (1–3s, ritmo natural do bot) tem risco de concorrência
desprezível; persistir e depender de tráfego externo faz o bot parecer "preso" esperando o lead
cutucar. **Solução:** abaixo de um limiar (ex.: 10s), dormir inline; acima, persistir e retomar.

### 8.5 Estado compartilhado entre execuções — a lição nº 3
Qualquer contador lembrado entre execuções (ex.: Randomizador round-robin) **não pode ser
ler→somar→salvar** em passos separados (duas execuções leem o mesmo valor e duplicam/pulam
caminho). Incremento em **uma única instrução atômica no banco**:
`UPDATE flow_node_counters SET counter = (counter + 1) % N WHERE ... RETURNING counter`.

### 8.6 Editar fluxo ao vivo — a lição nº 4
Se o builder apaga e recria um nó, o nó novo ganha ID diferente. Execuções paradas esperando
resposta naquele ID **perdem a referência** e são canceladas silenciosamente. Não há solução mágica
(é inerente a fluxo editável ao vivo), mas: **logar/avisar** quando uma retomada não encontra o nó,
em vez de falhar em silêncio. Preferir "editar conteúdo do nó" a "apagar+recriar" no builder.

### 8.7 Escopo do trava-novo-fluxo — a lição nº 5
Bloquear novo fluxo por **contato+instância inteira** foi um erro real: uma execução presa em
QUALQUER fluxo antigo impediu dezenas de leads de entrarem num fluxo novo e não relacionado.
**Recomendação (corrigindo o PRD): travar por (fluxo + contato)**, não por contato+instância. Assim
um fluxo travado não sequestra o contato inteiro. Complementar com timeout/limpeza de execuções
presas.

---

## 9. Requisitos não-funcionais

- **Sem estado em memória entre requisições.** Tudo que precisa ser lembrado (mesmo por segundos)
  vai pro banco.
- **Webhooks idempotentes e resilientes.** Resposta HTTP imediata; processamento pesado em
  background. Deduplicar por `wa_message_id`.
- **Cache-busting nos assets estáticos.** Nome fixo faz o browser cachear código antigo. Versionar a
  URL (`app.js?v=N` ou hash no nome). (Bug real: melhoria publicada que ninguém sentiu porque o
  browser nunca buscou o arquivo novo.)
- **Multi-tenancy por instância** (e por `org_id` na V2). Toda query escopada.
- **Live Chat:** `grid-template-rows` explícito.
- **Segredos** (tokens Meta, sessão Baileys) nunca no client; criptografados em repouso quando
  possível.

---

## 10. Fora de escopo v1

- Grupos de WhatsApp (só 1:1).
- Voice/chamadas.
- Multi-idioma da interface (só português).
- Cron externo garantido por padrão (melhoria futura documentada, não bloqueia lançamento).
- Baileys, multi-tenancy e mobile → **V2** (planejados, não construídos na v1).

---

## 11. Roadmap por fases (mapeado aos prompts)

| Fase | Entrega | Prompts |
|------|---------|---------|
| 0 | Fundação: repo, `repo.*`, `provider.*`, migrations, config | P0.1–P0.2 |
| 1 | Núcleo API oficial: instâncias, webhook, envio, templates, contatos/CRM | P1.1–P1.5 |
| 2 | Frontend + Live Chat + Dashboard | P2.1–P2.3 |
| 3 | Listas + Campanhas + motor de disparo em massa | P3.1–P3.2 |
| 4 | Motor de fluxos + builder visual (o coração) | P4.1–P4.5 |
| 5 | **V2:** multi-tenancy, Baileys, mobile APK | P5.1–P5.3 |

Critérios de sucesso (do PRD) que fecham cada fase relevante:
- Campanha de 1000+ contatos sem execuções perdidas silenciosamente (toda falha auditável).
- Fluxo com delays de segundos flui sem precisar do lead cutucar.
- Editar fluxo ativo não derruba conversa em silêncio (ou ao menos é logado).
- Nenhuma feature nova quebra outra por estado compartilhado mal desenhado.

---

## 12. Referência de frontend (do print anexo)

Layout a seguir no P2.1:

- **Sidebar escura** (quase preto/navy), logo verde WhatsApp "WA Manager / API Oficial Meta".
  Seções: **PRINCIPAL** (Dashboard, Instâncias) · **ENVIOS** (Disparar Mensagem, Disparo em Massa,
  Templates) · **ATENDIMENTO** (Live Chat com badge de não-lidas, Chatbot) · **MARKETING** (Listas,
  CRM, Campanhas) · **ANÁLISE** (Relatórios, Faturamento). Item ativo em verde.
- **Topo:** seletor de instância, status "Online", botão "Sair".
- **Dashboard:** linha de cards (Mensagens Enviadas, Recebidas, Contatos, Instâncias Ativas, Taxa de
  Entrega, Taxa de Leitura) · gráfico de área "Volume — Últimos 30 dias" (Enviadas vs Recebidas) ·
  donut "Tipos de Mensagem" · tabela "Volume por Instância".
- **Paleta:** fundo claro, cards brancos com sombra sutil, verde WhatsApp (~`#25D366`) como cor
  primária/acento. Visual SaaS limpo e moderno.
