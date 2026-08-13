# Multi-tenancy & V2 (Baileys) — Arquitetura, Auditoria e Decisões

> **Status:** revisado e **parcialmente implementado** — ver §6 (rodada P6.1: `org_members`,
> B1, B2, L1, L3, L5 e convites já estão em código). As decisões de §5 marcadas como
> "decidida" saíram do ar; o que sobrou lá continua aberto.
> **Complementa:** `01_PLANO_E_ARQUITETURA.md` (visão do produto, as duas abstrações, as 5 lições
> do motor de fluxos) e `DEPLOY.md` (infra concreta).
> **Regras que este documento respeita:** `CLAUDE.md` — `repo.*` e `provider.*` inegociáveis,
> zero estado em memória na camada web, sem falha silenciosa.

---

## 0. Aviso de premissa — leia antes do resto

O briefing desta rodada parte de duas premissas que a auditoria do código **não confirmou**:

| Premissa do briefing | O que o código mostra |
|---|---|
| "hoje tudo é escopado só por `instance_id`, sem noção de dono" | Existe `orgs`, `users`, `instances.org_id` e escopo por org em **todas** as rotas de `/api` (`migrations/*/006_orgs.sql`, `src/http/util.ts:51`) |
| "preparação para Baileys (V2)" | O `BaileysProvider`, o worker sempre-ligado, a `outbox`, a sessão persistida no banco e a UI de QR **já existem e têm teste** (`src/worker/`, `tests/baileys.test.ts`) |
| "`SECRETS_ENCRYPTION_KEY` validada no boot mas não usada" | ✅ **Confirmado.** É a maior dívida aberta (`src/config/env.ts:19-20, 61-67` — nenhum outro uso no código) |

Tudo isso entrou no commit inicial `2650495` ("V1 + V2 (multi-tenancy, Baileys, mobile)"). Ou seja:
o trabalho das fases P5.1 e P5.2 **foi feito**, mas nunca passou por uma revisão de arquitetura —
e é exatamente essa revisão que o briefing está pedindo, com a diferença de que ela agora é uma
**auditoria do que existe** em vez de um projeto do zero.

Este documento, portanto:

1. Registra o estado real (§1), com arquivo e linha.
2. Responde a **todas** as perguntas do briefing (§2 e §3) — mas dizendo, para cada uma, "isto já
   está assim / isto precisa mudar / isto está errado", em vez de propor no vazio.
3. Concentra em §5 tudo o que depende de uma decisão sua.

Há **três defeitos reais** encontrados nessa auditoria, listados em §1.3. O mais grave (`B1`)
faz o Rafael perder o acesso à instância de produção no exato momento em que criar a primeira
conta. Ele é barato de corrigir agora e caro depois.

---

## 1. Estado real auditado

### 1.1 Multi-usuário — o que já existe

| Peça | Onde | Situação |
|---|---|---|
| Tabelas `orgs` e `users` | `migrations/{postgres,sqlite}/006_orgs.sql` | Criadas; org `org_default` semeada |
| `instances.org_id` | idem + `src/repo/types.ts:45` | Coluna adicionada, backfill para `org_default` feito |
| Hash de senha (scrypt) + JWT HS256 caseiro | `src/util/auth.ts` | Sem dependência externa; `timingSafeEqual` nos dois lados |
| Middleware de auth + modo bootstrap | `src/http/auth.ts:17-48` | Bearer válido → `req.auth`; zero usuários → owner da `org_default`; senão 401 |
| `POST /api/auth/register` e `/login` | `src/http/auth.ts:68-109` | Montadas **antes** do middleware (`src/http/app.ts:54`) |
| Gargalo único de escopo | `src/http/util.ts:51-60` (`requireInstance`) | Instância de outra org → **404** (não vaza existência) |
| `requireOwner` | `src/http/util.ts:32-43` | Aplicado nas rotas de gestão em `src/http/app.ts:69-77` |
| Cobertura de escopo | grep em `src/http/*.ts` | **Todas as 55 rotas** sob `/api/instances/:id` chamam `requireInstance(repo, id, getAuth(req).orgId)` |
| Frontend | `src/web/app.js:8-45, 2826-2846` | Tela de login/registro, token em `localStorage`, 401 → volta pro login |
| Mobile | `mobile/src/api.ts:46-90` | Mesmo login, token em `AsyncStorage`, header `Bearer` |
| Testes | `tests/multitenancy.test.ts` | Isolamento cross-org, papéis, trancamento do bootstrap, migração sem perda |

**Conclusão:** o isolamento cross-org está implementado e é estruturalmente sólido — porque toda a
cadeia de dados (`contacts`, `messages`, `campaigns`, `flows`, `tags`, `crm`, `lists`) pende de
`instance_id`, e `instance_id` só entra no sistema via `requireInstance`.

### 1.2 Baileys / V2 — o que já existe

| Peça | Onde | Situação |
|---|---|---|
| `provider_type` `'meta' \| 'baileys'` | `migrations/*/001_init.sql`, `src/repo/types.ts:7` | Já no schema desde o início |
| Dispatcher por tipo | `src/providers/index.ts:29-48` | `switch` exaustivo com `never` — tipo novo quebra o build, não o runtime |
| `BaileysProvider` | `src/providers/BaileysProvider.ts` | Traduz `provider.*` num payload normalizado e delega ao transporte |
| Dois transportes | idem `:33` e `src/worker/baileysWorker.ts:207` | Web → `outbox`; worker → socket vivo |
| Tabelas `outbox` e `baileys_auth` | `migrations/*/007_baileys.sql` | Claim atômico na outbox; sessão por chave/valor |
| Worker sempre-ligado | `src/worker/{index,baileysWorker,realSocket,dbAuthState}.ts` | Socket por instância, reconexão com backoff, QR persistido, inbound reusando `recordInbound` + motor de fluxos |
| `capabilities` por provider | `src/providers/types.ts:52-60` | `template: false`, `cta: false` no Baileys — a UI esconde e a rota devolve 422 |
| UI de pareamento | `src/http/instances.ts:96-122` + `src/web/app.js:2708` | `GET /qr` e `/qr.svg` (renderizado no servidor, buscado com o Bearer) |
| Deploy do worker | `DEPLOY.md §4` | Railway documentado como caminho preferido; Fly/VPS como alternativa |
| Testes | `tests/baileys.test.ts` | Outbox, claim atômico, inbound reativo, QR/reconexão, sessão sobrevivendo a "restart" |

### 1.3 Defeitos e lacunas encontrados

Ordenados por gravidade. Os `B*` são bugs; os `L*` são lacunas de desenho.

**B1 — O primeiro registro órfã a instância de produção. (crítico, e é a pergunta 4 do briefing)**
`POST /api/auth/register` (`src/http/auth.ts:78`) sempre cria uma **org nova**. A instância real
(`ea46ca72-…`) está em `org_default`. Sequência em produção hoje:

1. Rafael abre o painel → modo bootstrap → vê a instância normalmente.
2. Rafael cria sua conta pela tela de registro → nasce, digamos, `org_a1b2…`.
3. `users.countAll()` vira 1 → bootstrap desliga (`src/http/auth.ts:36`).
4. Rafael loga → `GET /api/instances` filtra por `org_a1b2…` → **lista vazia**.
5. A instância, as conversas, os fluxos e as campanhas continuam no banco, invisíveis, sem
   nenhum usuário capaz de alcançá-los. O webhook continua funcionando (é máquina-a-máquina),
   então o sistema segue recebendo mensagens que ninguém consegue ver.

Não é perda de dados, é perda de acesso — e a recuperação exige `UPDATE` manual no Postgres.
O teste `tests/multitenancy.test.ts:41` valida a migração até o passo 1 e para ali; nenhum teste
cobre "bootstrap → primeiro registro → ainda enxergo o que era meu".

**B2 — `POST /api/auth/register` é público e sem trava. (grave)**
Está montado antes do middleware de auth, sem nenhum gate. Consequências:
(a) qualquer pessoa com a URL cria uma conta no seu deploy; (b) esse cadastro **desliga o modo
bootstrap para todo mundo** (`countAll()` é global), o que transforma o item B1 num ataque de
negação de acesso trivial. Isso vale mesmo que hoje seja "só uso próprio" — a URL da Vercel é
pública.

**B3 — Instância Baileys criada com o worker no ar nunca conecta.** ✅ **CORRIGIDO.**
`BaileysWorker.start()` listava as instâncias **uma vez** e nunca mais varria: criar uma instância
pelo painel e clicar em "QR" esperava para sempre, sem erro nem log. Agora `scanInstancesOnce()`
roda no boot **e** a cada `WORKER_SCAN_INTERVAL_S` (default 30s), abrindo socket para toda Baileys
ativa sem um — e fechando o das desativadas/removidas.

**B4 — Outbox de instância desconectada acumula em silêncio.** ✅ **CORRIGIDO.**
`processOutboxOnce` itera sobre `this.sockets`, ou seja, só instâncias **conectadas** — se o número
cai, ninguém consome a fila. Agora a varredura periódica chama `failStaleOutbox()`: item `pending`
há mais de `OUTBOX_STALE_MINUTES` (default 60) numa instância **sem socket** vira `failed` com
motivo `instance_disconnected_timeout`, na outbox **e** na mensagem ligada — o Live Chat para de
mostrar "queued" eterno. Sai também um `console.warn` com a contagem e a instância. Alerta externo
(email/Slack) continua fora de escopo.

**L1 — Segredos em texto claro no banco. (a dívida que o briefing já suspeitava)**
`instances.token`, `instances.verify_token` e `baileys_auth.value` são gravados como vieram
(`PostgresAdapter.ts:53-57, 1031-1036`). A `SECRETS_ENCRYPTION_KEY` é exigida em produção no boot
e **não criptografa nada**. A sessão do Baileys é o pior caso: quem a lê está logado no WhatsApp
da pessoa — não é "um token de API a mais".

**L2 — `META_APP_SECRET` é global, um por deploy.**
`src/http/metaSignature.ts` valida a assinatura do webhook com uma única variável de ambiente.
Funciona enquanto todas as instâncias estiverem sob o **seu** App Meta. No dia em que um cliente
trouxer o WABA dele, sob o App Meta dele, o POST daquele cliente falha a assinatura e o webhook
descarta tudo (fail-closed, como projetado). Mesma família: `verifyChallenge` compara o
`hub.verify_token` contra as instâncias de **todas** as orgs (`src/domain/webhook.ts:385`) — o
que é aceitável hoje, mas é um vazamento de informação entre tenants no futuro.

**L3 — `instances.org_id` é nullable, sem FK e sem `NOT NULL`.**
O default `'org_default'` mora no adapter (`PostgresAdapter.ts:57`), não no banco. Uma inserção
que não passe pelo `repo.*` (script, migration futura, psql na mão) cria uma instância sem dono —
invisível para todo mundo, mas ainda processada por cron, webhook e worker.

**L4 — Um usuário pertence a exatamente uma org.**
`users.org_id` é coluna direta, e-mail é único global. Não existe tabela de vínculo. Consequência:
o mesmo e-mail não pode ser agente de duas contas, e não existe "trocar de org".

**L5 — Sem convite, sem troca de senha, sem revogação de sessão.**
O owner cria o usuário **digitando a senha dele** (`src/http/auth.ts:142`) e a repassa por fora.
Não há `POST /logout` no servidor, nem `password_changed_at`, nem lista de revogação: um JWT
vazado vale 7 dias (`src/util/auth.ts:36`), mesmo depois de o usuário ser removido — e, aliás,
**não existe rota para remover usuário**.

**L6 — Duas réplicas do worker brigam pelo mesmo número.**
Nada impede dois processos de abrirem socket para a mesma instância Baileys. O WhatsApp derruba
uma das sessões, o backoff reconecta, e o par entra em ciclo. Hoje isso é contido por convenção
("suba uma réplica só"), não por código.

---

## 2. Parte 1 — Multi-usuário e separação de contas

### 2.1 Modelo de dados

#### Nomenclatura: fico com `org`

Mantenho `orgs`/`org_id`, e não `accounts`. Três razões: (a) é o termo que o `CLAUDE.md` já fixa
("V2: adicionar `org_id`") e que está no schema, nos tipos, no JWT (`org_id` no payload) e no
frontend — renomear custa uma migration, um round de auditoria e zero benefício funcional;
(b) "account" é ambíguo em produto de WhatsApp, onde "conta" já significa conta do WhatsApp
Business/WABA; (c) `org` deixa espaço para o dia em que uma agência gerenciar vários clientes.

#### Desenho proposto

**`orgs`** — existe, e está adequada. Campos atuais: `id`, `name`, `plan`, `created_at`.
Sugiro **não** mexer agora. `plan` é um placeholder honesto; quando houver cobrança, ele vira
FK para uma tabela de planos, não texto livre.

**`users`** — existe. Proponho **quatro acréscimos**, todos baratos e todos motivados por defeito
real, não por completude:

| Campo | Por quê |
|---|---|
| `status` (`active` \| `disabled`) | Hoje não há como desligar um usuário; deletar a linha não invalida o JWT dele (L5) |
| `password_changed_at` | Permite invalidar tokens emitidos antes da troca de senha, sem tabela de revogação |
| `name` | A UI só tem e-mail para exibir; um agente no Live Chat precisa de nome |
| `last_login_at` | Diagnóstico e "quem ainda usa isto?" — custo zero |

**Vínculo user↔org.** Aqui há uma decisão de verdade (→ **D5**):

- **Opção A — manter `users.org_id` (1:1).** É o que existe. Zero trabalho, zero risco.
  Custo: e-mail único global impede o mesmo endereço em duas contas; para virar agente de outra
  org, cria-se outro usuário com outro e-mail.
- **Opção B — criar `org_members(org_id, user_id, role)` (N:N).** `users` guarda só identidade
  (e-mail, senha, nome); o papel migra para o vínculo. O JWT passa a carregar a org **ativa**
  (a que o usuário escolheu na sessão), e o middleware precisa validar, a cada request, que
  aquele usuário ainda é membro daquela org — hoje ele confia cegamente no `org_id` do token.

**Minha recomendação: A por enquanto, B se o produto for vendido a agências.** O motivo é
assimetria de custo: A→B depois é uma migration mecânica (uma linha em `org_members` por usuário
existente) mais uma mudança localizada em `auth.ts` e no `repo.users`. Não é o tipo de coisa que
"fica cara depois de implementada errada". O que **é** caro depois é escopo vazado — e esse já
está resolvido.

**`instances`** — pertence a uma org **hoje**, via `org_id`. As correções são de integridade, não
de desenho (L3): tornar a coluna `NOT NULL`, criar a FK para `orgs(id)` com `ON DELETE RESTRICT`
(apagar uma org com instância viva deve doer, não cascatear em silêncio sobre conversas reais) e
mover o default `'org_default'` do adapter para o banco — ou, melhor, **eliminar o default** e
exigir `org_id` explícito em toda criação, já que a rota sempre tem `auth.orgId` à mão. Default
silencioso é o mecanismo que produz L3.

#### O resto do schema: nada de `org_id` em cascata

**Proposta explícita: não adicionar `org_id` a `contacts`, `messages`, `campaigns`, `flows`, etc.**
Toda essa cadeia pende de `instance_id`, que por sua vez pende de `org_id`. Denormalizar o
`org_id` para baixo criaria dezenas de colunas que podem divergir do pai — e uma coluna que pode
divergir vai divergir. O isolamento fica onde já está: no gargalo único.

A exceção defensável é **`campaign_sends`**, que hoje só tem `campaign_id` e é a tabela de maior
volume; se algum dia um relatório precisar varrê-la por org sem `JOIN`, aí sim vale a
denormalização — como otimização consciente, não como regra.

### 2.2 Escopo em cascata — o que auditar quando isto for mexido

O padrão é: **`org_id` → `instance_id` → resto**, com `requireInstance` como único portão. O que
o trabalho de auditoria precisa cobrir, quando houver mudança:

**Camada HTTP — já conforme, mas é onde a regressão nasce.** Todas as rotas sob
`/api/instances/:id/*` (`messages`, `livechat`, `templates`, `contacts`, `tags`, `crm`,
`dashboard`, `lists`, `flows`, `campaigns`) passam o `orgId`. O risco não é o estado atual, é a
**próxima rota**: nada no código impede alguém de escrever `requireInstance(repo, id)` sem o
terceiro argumento — o parâmetro é opcional (`src/http/util.ts:54`). Recomendo tornar `orgId`
**obrigatório** na assinatura e criar um `requireInstanceSystem()` separado e explícito para os
chamadores máquina-a-máquina. Torna o caminho inseguro impossível de escrever por distração, que
é a única forma de escrevê-lo.

**Rotas sem `:id`.** `GET /api/instances` (filtra por org ✅), `/api/users` (filtra por org ✅).
Qualquer rota futura sem `:id` — busca global, relatório consolidado, exportação — é candidata
natural a vazamento e precisa de revisão individual.

**Camada `repo.*`.** Métodos que **não** recebem escopo, por desenho, e que devem permanecer numa
lista curta e justificada: `instances.list()` sem argumento (worker e cron), `getByPhoneNumberId`
(webhook), `users.getByEmail` (login), `users.countAll` (bootstrap), `outbox.claimPending`,
`baileysAuth.*`, `messages.updateById`, `campaigns.updateSend`. Os dois últimos operam por id
opaco sem verificar dono — aceitável porque só o worker os chama, mas devem virar comentário
explícito na interface, não conhecimento tácito.

**Contextos máquina-a-máquina — cross-org por desenho, e deve continuar assim:**

| Contexto | Escopo | Autenticação |
|---|---|---|
| Webhook (`POST /webhook`) | Resolve a instância pelo `phone_number_id` do payload | Assinatura HMAC da Meta |
| Cron (`/api/cron/tick-campaigns`) | `instances.list()` sem org — varre tudo | `CRON_SECRET` |
| Worker Baileys | `instances.list()` sem org — abre socket de todas | Acesso direto ao Postgres |

Isso está correto e **não deve mudar**: são processos do sistema, não de um usuário. O que muda
é a documentação — hoje isso é convenção implícita.

**Testes.** `tests/multitenancy.test.ts:90` já cobre "org A não enxerga org B" nas rotas
principais. Falta um teste que percorra **todas** as rotas registradas e falhe quando uma nova
não tiver caso cross-org — o teste que impede a regressão futura, em vez de checar o presente.

### 2.3 Autenticação

**O que existe:** JWT HS256 assinado à mão (`src/util/auth.ts`), 7 dias, sem refresh, guardado em
`localStorage` na web e `AsyncStorage` no mobile.

| Estratégia | A favor | Contra |
|---|---|---|
| **JWT em `localStorage`** (atual) | Serverless sem estado de sessão; um mecanismo só para web e mobile; nenhum problema de CSRF; nada a mudar | Vulnerável a XSS (script injetado lê o token); revogação exige estado no servidor; 7 dias é uma janela larga |
| **Cookie `httpOnly` + `SameSite=Lax`** | XSS não lê o token; expiração controlada pelo servidor; logout de verdade | Precisa de CSRF token nas mutações; **quebra o app mobile** (`mobile/src/api.ts` fala `Bearer`); cookie cross-site com a Vercel exige cuidado com domínio |
| **Sessão opaca no banco** | Revogação instantânea, "encerrar sessões", auditoria | Uma consulta ao Postgres por request na camada serverless — custo direto no p95 de toda a API |
| **Híbrido** (cookie na web, Bearer no mobile) | Melhor dos dois | Dois caminhos de auth para manter e testar; dobra a superfície do middleware |

**Recomendação: manter JWT Bearer, e fechar as três frestas que realmente importam.** O mobile é
o argumento decisivo — ele já existe e já autentica por header; migrar para cookie transforma
uma dívida de segurança moderada num refactor de duas plataformas. Os endurecimentos que
proponho, em ordem de valor por esforço:

1. **Expiração de 7 dias → 12 horas, com refresh silencioso** enquanto o app estiver em uso.
   Reduz a janela de um token vazado em ~14×, sem tocar em nenhuma outra camada.
2. **Revogação sem tabela nova:** o middleware compara o `iat` do token com o
   `password_changed_at`/`status` do usuário. Custa uma leitura de `users` por request — que o
   modo bootstrap **já faz hoje** (`users.countAll()` em toda request, `src/http/auth.ts:36`),
   então o custo marginal é zero e ganhamos "trocar a senha derruba todas as sessões".
3. **Fechar o registro público** (→ B2 e D2).

Fora de escopo, e deliberadamente: 2FA, SSO/OAuth, rate limit de login. O rate limit é o único
que eu levantaria cedo se o registro ficar aberto — sem ele, `/login` é um oráculo de força bruta
com scrypt como única defesa.

### 2.4 Migração do estado atual (a instância `ea46ca72-…`)

O problema está descrito em **B1**. O estado de partida é bom: a migration `006_orgs.sql` já criou
`org_default` e já associou a instância existente a ela, sem perda. O que falta é o **passo
seguinte** — colocar um dono humano em `org_default` em vez de criar uma org nova e órfã.

Três caminhos (→ **D3**):

**Caminho A — "primeiro registro adota a org default".** `POST /register`, quando
`users.countAll() === 0` **e** a `org_default` tem instâncias, cria o owner **dentro** da
`org_default` (usando `org_name` para renomeá-la, em vez de criar outra). Do segundo registro em
diante, comportamento atual.
*A favor:* Rafael faz o caminho normal pela tela e tudo continua no lugar; é a correção do B1 no
próprio ponto do defeito; funciona igual em qualquer ambiente novo.
*Contra:* um ramo condicional a mais no register, que precisa de teste próprio.

**Caminho B — script de bootstrap (`npm run create-owner`).** Um comando de linha que cria o
owner na org informada. Rafael roda uma vez contra o Postgres de produção **antes** de abrir a
tela de registro.
*A favor:* explícito, auditável, não muda a rota; serve depois para "esqueci a senha do owner".
*Contra:* é um passo manual que só funciona se for executado na ordem certa — se ele registrar
pela tela primeiro, cai no B1 e precisa de `UPDATE` na mão.

**Caminho C — migration `010` que cria o usuário.** Rejeito. Migration não é lugar de segredo:
ou a senha vai versionada no repositório, ou vem de env var lida em tempo de migration — as duas
opções são piores que A e B.

**Minha recomendação: A + B.** São complementares e nenhum dos dois é caro. A cobre o caminho
feliz e protege qualquer deploy novo; B é a ferramenta de recuperação para quando alguém já
tiver caído no B1 (inclusive em produção, se isto demorar a ser corrigido).

Independente do caminho, a sequência de produção deve ser: (1) confirmar no Supabase que
`instances.org_id = 'org_default'` para `ea46ca72-…`; (2) criar o owner; (3) logar e conferir que
a instância, as conversas e os fluxos aparecem; (4) só então considerar o bootstrap encerrado.

### 2.5 Fim do modo bootstrap

**Hoje a transição é atômica e implícita:** basta existir um usuário para toda a API exigir token
(`src/http/auth.ts:36`). Não há período de transição, e — importante — **isso está certo**. Um
"modo misto" (algumas rotas exigindo login, outras não) é a pior configuração possível: dá a
sensação de progresso e deixa buracos que ninguém audita. A transição em degrau, com um estado
verificável antes e depois, é mais segura.

O que precisa mudar não é o degrau, é **quem consegue puxar a alavanca** (B2). Proponho:

- **Registro público fechado por default,** liberado por uma env var explícita (algo como
  `PUBLIC_SIGNUP=true`). Enquanto ela não existir, `/api/auth/register` só responde **no modo
  bootstrap** — isto é, exatamente uma vez, para criar o primeiro owner, e depois nunca mais.
  Usuários subsequentes entram por convite (§2.6). Mesmo espírito fail-closed do `CRON_SECRET` e
  do `META_APP_SECRET`: a ausência da variável fecha, não abre.
- **Aviso visível no painel enquanto o bootstrap estiver ativo** ("Este sistema está aberto —
  crie sua conta"). Hoje o único sinal é o painel não pedir login, o que se confunde com "estou
  logado". `DEPLOY.md:284` já trata isso como sintoma de troubleshooting.

**Impacto no cron:** nenhum. `/api/cron/*` é montado **antes** do middleware de auth
(`src/http/app.ts:58`) e tem mecanismo próprio (`CRON_SECRET`, fail-closed em 503 se ausente).
Não passa a exigir usuário — nem deve, e o mesmo vale para o workflow do GitHub Actions.

**Impacto no webhook:** nenhum. `/webhook` fica fora de `/api` (`src/http/app.ts:82`) e autentica
por assinatura HMAC da Meta. É máquina-a-máquina por natureza.

**Impacto no worker Baileys:** nenhum — ele não fala HTTP com a API, compartilha o Postgres.

Vale registrar a consequência: com o bootstrap desligado, **o webhook e o cron continuam
processando mensagens de uma org sem usuário nenhum**. É o cenário do B1. Sugiro que a varredura
do cron logue (não interrompa) quando encontrar instância ativa em org sem usuários — um dado que
teria tornado o B1 visível em minutos em vez de na primeira reclamação.

### 2.6 Convites e onboarding

**Hoje:** o owner cria o usuário via `POST /api/users` **escolhendo a senha** e a transmite por
fora (WhatsApp, e-mail, papel). Funciona, mas o owner conhece a senha do agente — o que arruína
qualquer noção de não-repúdio — e não existe fluxo de troca.

**Proposta (nível de desenho, sem detalhar tela):**

1. Owner informa e-mail e papel → o sistema grava um **convite** (token aleatório, org, papel,
   validade de ~72h, estado pendente/aceito/expirado) e devolve um **link** ao owner.
2. O convidado abre o link (rota pública, como `/login`), define a **própria** senha, e o aceite
   cria o usuário na org do convite e consome o token numa operação atômica.
3. Owner vê pendentes, revoga e reenvia.

O envio do e-mail é opcional na primeira versão — "copiar link" resolve, e evita trazer provedor
de e-mail para o projeto agora. Duas coisas de segurança que não podem faltar: o token precisa
ser aleatório e **de uso único** (o consumo é a mesma transação que cria o usuário), e o papel
vem do convite, **nunca** do que o convidado manda no corpo da requisição.

Isto substitui o `POST /api/users` atual; a rota some, e com ela a senha escolhida por terceiro.

### 2.7 Fora de escopo: permissões granulares

O briefing pede para não desenhar permissão por funcionalidade a menos que seja trivial. **Não é
trivial, e é decisão adiada** (→ **D7**). Registro por quê e o que fica preparado:

O modelo atual tem dois papéis (`owner`, `agent`) aplicados **por rota**, no `app.ts`. Isso cobre
o caso real ("agente atende no Live Chat, não mexe em campanha") com quatro linhas de código e
zero tabelas. Uma matriz de permissões de verdade (recurso × ação × papel, papéis customizados)
exige tabela de papéis, tabela de permissões, um resolvedor no middleware, propagação para a UI
(que precisa esconder o que o usuário não pode fazer) e testes combinatórios. É um projeto, não
um acréscimo.

O que já está previsto sem custo: `role` é uma coluna de texto, então **novos papéis nomeados**
(`supervisor`, `financeiro`) cabem sem migration — só um `enum` no Zod e a checagem na rota. Isso
cobre o próximo degrau de granularidade sem abrir o projeto inteiro. O que **não** cabe sem
migration é permissão por instância ("este agente só atende a Loja A") — que, se for requisito,
muda o desenho e precisa entrar antes, não depois.

---

## 3. Parte 2 — Instâncias via Baileys

> A decisão de base (Baileys exige WebSocket persistente, incompatível com serverless; `provider.*`
> abstrai os dois) está em `01_PLANO_E_ARQUITETURA.md §2` e **não é reaberta aqui**.

### 3.1 Modelo de dados: `provider_type` e campos por tipo

**Já existe** (`instances.provider_type`, default `'meta'`) e o dispatcher já resolve por ele.

**Sobre o nome:** o briefing fala em `meta_cloud`; o código usa `'meta'`. Recomendo **manter
`'meta'`** — renomear implica migration de dados, mudança no `enum` do Zod, no tipo, no frontend
e no dispatcher, para ganhar precisão de vocabulário num valor que não é exposto ao usuário
final. Fica registrado como divergência consciente entre briefing e código (→ **D9**, se você
discordar).

**Campos por tipo, hoje, tudo em `instances`:**

| Campo | `meta` | `baileys` |
|---|---|---|
| `phone_number_id`, `waba_id`, `token`, `verify_token` | obrigatórios na prática | sempre nulos |
| `connection_status` | informativo (definido na mão) | dirigido pelo worker (`pending`/`connected`/`disconnected`) |
| sessão de auth | — | **fora de `instances`**, em `baileys_auth` (chave/valor por instância) |

A pergunta do briefing — "como isso não vira tabela cheia de colunas nulas pela metade" — já tem
uma resposta parcial boa: **a sessão do Baileys, que seria o campo mais gordo e mais volátil, já
está numa tabela própria**. O que sobra é quatro colunas nulas em instâncias Baileys. Opções
(→ **D_esquema**, dentro de D9):

- **Manter como está.** Quatro colunas nulas não justificam refactor. O que falta é
  **validação por tipo na entrada** — hoje `createSchema` (`src/http/instances.ts:40`) aceita
  `phone_number_id` numa instância Baileys e aceita uma instância `meta` **sem token nenhum**.
  Um refinamento discriminado por `provider_type` na validação resolve o problema real (dados
  incoerentes) sem tocar no schema.
- **Coluna `config` JSON por tipo.** Elimina as nulas, mas perde o índice único de
  `phone_number_id` (que é o que o webhook usa para achar a instância) e joga a tipagem para
  dentro de um `unknown`. Piora mais do que melhora.
- **Tabela lateral `meta_instance_config`.** Normalização correta em teoria; um `JOIN` a mais em
  todo caminho quente para resolver quatro colunas. Desproporcional.

**Recomendo a primeira**, com a validação discriminada. E remover `instances.baileys_session_ref`
(`src/repo/types.ts:53`), que é um campo morto — a sessão mora em `baileys_auth`, e campo morto
no tipo é convite a alguém "usar o que já existe".

### 3.2 Onde o worker persistente roda

`DEPLOY.md §4` já documenta **Railway** com `npm run worker:prod`, e cita Fly/VPS como
alternativa. Não encontrei evidência de que esteja provisionado. A escolha é sua (→ **D1**);
segue o comparativo honesto:

| Opção | Custo mensal (ordem) | Complexidade operacional | Observações |
|---|---|---|---|
| **Railway** | ~US$ 5 + uso | **Baixa** — deploy por Git, logs no painel, restart automático | Já documentado; caminho de menor atrito; cobrança por uso pode subir com socket 24/7 |
| **Fly.io** | ~US$ 2-5 | Média — `fly.toml`, conceito de máquina/volume | Boa presença no Brasil (GRU) = latência menor até o Postgres |
| **Render** | ~US$ 7 (worker) | Baixa | Plano gratuito **hiberna** — inútil aqui: hibernar mata o socket e derruba a sessão |
| **VPS (Hetzner/DO/Contabo)** | ~US$ 4-6 | **Alta** — SO, `pm2`/systemd, atualização de segurança, monitoramento, backup | Mais barato por CPU/RAM e sem surpresa de cobrança; você vira o sysadmin |
| **Fargate/Cloud Run c/ min-instances** | US$ 15+ | Alta | Só se já houvesse AWS/GCP no projeto — não há |

Três critérios que valem mais que o preço, e que sugiro pesar na decisão:

1. **Reinício destrói a sessão?** Não — `baileys_auth` persiste no Postgres e o worker restaura
   (`tests/baileys.test.ts:301`). Isso já derruba o maior risco de plataforma efêmera. Mas
   redeploy = janela de segundos a minutos sem receber mensagem, em **todas** as instâncias
   Baileys ao mesmo tempo.
2. **Uma réplica, sempre** (L6). Duas réplicas brigam pelo socket. Qualquer plataforma escolhida
   precisa ficar travada em 1 instância — e, se algum dia precisar de mais, o desenho correto é
   **partição por instância com lock no banco** (cada worker reivindica um conjunto de instâncias
   com heartbeat), não escala horizontal ingênua.
3. **Latência até o Postgres.** O worker conversa muito com o banco (outbox a cada 2s, gravação de
   sessão a cada evento). Worker na Europa + Supabase em `sa-east-1` é uma péssima combinação.
   Vale colocá-lo na mesma região do banco.

**Não escolho por você** — é decisão de custo e de quanto trabalho de operação você quer ter.
Se me perguntar a inclinação: Railway pelo primeiro ano (o tempo economizado vale a diferença de
poucos dólares), com a nota de que migrar Railway→VPS depois é fácil, porque o worker não tem
estado local nenhum.

### 3.3 Sessão do Baileys, `SECRETS_ENCRYPTION_KEY` e os tokens da Meta

**Diagnóstico.** O `useMultiFileAuthState` (arquivos em disco) já foi corretamente substituído por
`makeDbAuthState` (`src/worker/dbAuthState.ts`), que persiste no Postgres com `BufferJSON` para
preservar os `Buffer` das credenciais. O problema **não** é onde a sessão mora — é que ela mora
**em texto claro**, junto com os tokens da Meta (L1), enquanto a `SECRETS_ENCRYPTION_KEY` é
exigida no boot e não faz nada.

Proponho **resolver os dois juntos**, como o briefing sugere, e pelo motivo certo: é o mesmo
mecanismo, aplicado em dois pontos, e a sessão do Baileys é mais sensível que o token da Meta
(quem a possui **está logado no WhatsApp**, envia em nome do dono, lê o histórico; o token da
Meta é revogável pelo painel e tem escopo, a sessão não).

**Desenho proposto — envelope no `repo.*`:**

- **Onde:** na fronteira dos adapters, no caminho de escrita/leitura de campos marcados como
  secretos. Nenhum módulo de negócio, nenhuma rota e nenhum worker sabe que existe criptografia —
  mesma disciplina de `repo.*` e `provider.*`.
- **O quê:** `instances.token`, `instances.verify_token`, `baileys_auth.value`. Nada além disso
  por ora — criptografar conteúdo de mensagem é outra conversa (quebra busca e Live Chat).
- **Como:** AES-256-GCM (autenticado — detecta adulteração, o que CBC não faz), IV aleatório por
  valor, chave derivada da `SECRETS_ENCRYPTION_KEY`. O valor gravado carrega um **prefixo de
  versão** (`enc:v1:`), o que dá duas coisas de graça: leitura tolerante durante a migração
  (sem prefixo = texto claro legado, lê como está) e caminho de rotação de chave depois.
- **Migração dos dados existentes:** varredura única que lê, cifra e regrava. Como a leitura
  tolera os dois formatos, a migração pode rodar **depois** do deploy do código, sem janela.
- **Falha alta:** valor com prefixo `enc:` que não decifra é **erro**, nunca `null` silencioso —
  senão uma chave errada em produção vira "instância sem token", o webhook para e ninguém
  entende por quê.

**Duas perguntas que precisam de resposta sua** (→ **D8**): (a) o que fazer com os segredos já
gravados em claro — recifrar é o padrão, mas há argumento para **rotacionar** o token da Meta e
re-parear a sessão do Baileys, partindo do princípio de que tudo que esteve em claro num backup
deve ser considerado comprometido; (b) onde a chave vive (env var na Vercel + Railway é o
caminho pragmático; um KMS é o caminho correto e é desproporcional hoje) — e o que acontece se
ela for perdida: **os dados cifrados são irrecuperáveis**, e a recuperação é re-cadastrar token e
re-escanear QR. Isso precisa estar escrito no `DEPLOY.md`.

Uma consequência que vale explicitar: com a criptografia no `repo.*`, **o worker precisa da mesma
chave que a Vercel** (`DEPLOY.md:219` já lista `SECRETS_ENCRYPTION_KEY` nas variáveis do Railway).
Chaves diferentes = worker não lê a sessão que a web gravou. É a falha mais provável dessa
implementação e merece uma verificação no boot do worker.

### 3.4 Fluxo de conexão (pareamento por QR)

**Já implementado.** O fluxo de dados atual:

```
Painel                      Postgres                      Worker (sempre-ligado)
  │                            │                                  │
  │ POST /api/instances        │                                  │
  │  {provider_type: baileys}  │                                  │
  ├───────────────────────────►│ instances (status=disconnected)   │
  │                            │◄─ lê instâncias no start E a cada ┤  varredura periódica
  │                            │   30s (WORKER_SCAN_INTERVAL_S)    │  (B3 corrigido)
  │                            │                                  │ abre socket
  │                            │      baileys_auth['qr'] = <str>  │◄─┤ evento connection.update{qr}
  │                            │      instances.status = pending  │◄─┤
  │ GET /instances/:id/qr.svg  │                                  │
  ├───────────────────────────►│ lê 'qr' → renderiza SVG          │
  │◄─── SVG (Bearer no fetch) ─┤                                  │
  │  usuário escaneia no celular ─────────────────────────────────►│ connection.update{open}
  │                            │      apaga 'qr'; status=connected│◄─┤
  │ polling do painel          │                                  │
  ├───────────────────────────►│ status=connected → some o QR     │
```

Detalhes que o desenho já acerta e que vale registrar: o QR é gerado **pelo worker** (só ele tem
socket) e trafega pelo banco — a web nunca fala com o worker por HTTP; o SVG é renderizado no
servidor e buscado por `fetch` com o `Bearer`, porque `<img src>` não manda header
(`src/web/app.js:2708`); o worker é a **única** autoridade sobre `connection_status` de instância
Baileys.

**O que falta neste fluxo:**

- ~~**B3** — instância nova não conecta até o worker reiniciar.~~ **CORRIGIDO.** O worker varre
  a cada 30s (`WORKER_SCAN_INTERVAL_S`) procurando instâncias Baileys ativas sem socket e conecta
  (`baileysWorker.ts:scanInstancesOnce`). O boot usa a MESMA função. A varredura também fecha o
  socket de instância desativada/removida, que antes ficava órfã recebendo mensagem e rodando
  fluxo de um número que o painel dava como desligado.
- **QR sem validade explícita.** O QR expira e o Baileys emite outro (primeiro após ~60s, depois a
  cada ~20s), sobrescrevendo a linha. O caso "worker caiu e deixou QR morto no banco" **foi
  corrigido**: o `close` agora apaga o `qr` (`baileysWorker.ts:335`), porque o `ref` pertence ao
  socket que morreu. O que ainda não existe é um carimbo de emissão — dentro de um socket vivo, um
  QR de 19s ainda é servido como se fosse novo.
- **Não existe "desconectar/re-parear" na UI.** Só o logout vindo do celular limpa a sessão
  (`baileysWorker.ts:308`). Trocar de número exige mexer no banco.
- **Pareamento por código de 8 dígitos** (alternativa ao QR, útil quando o celular não está à
  mão) não está implementado. É acréscimo pequeno sobre o mesmo desenho, se você quiser.

### 3.5 Impacto na abstração `provider.*`

**Resposta curta: a abstração está pronta e provou que está** — o `BaileysProvider` foi acoplado
sem que o motor de fluxos, as campanhas ou o Live Chat mudassem uma linha. Isso é exatamente o
que `01_PLANO_E_ARQUITETURA.md §4.2` prometeu, e é raro que se confirme.

Os pontos que **ainda assumem Meta implicitamente**, em ordem de importância:

1. **Formato de erro.** `MetaApiError` carrega `code`/`message` da Graph API e é o que alimenta
   `messages.error_code`/`error_message`. O Baileys não tem códigos numéricos — o worker grava
   `error_code: null` e a mensagem do `Error` (`baileysWorker.ts:357`). Funciona, mas o
   `CLAUDE.md` manda "retry só em rate-limit (`130429`, `131056`), sem retry em erro permanente":
   essa política **não tem equivalente no Baileys**, porque não há como classificar o erro.
   Generalizar significa um erro de provider com uma **classificação** própria
   (`rate_limit | permanent | transient | unknown`) que cada adapter preenche — a política de
   retry passa a ler a classificação, não o código da Meta.
2. **`SendResult.outboxId`** (`src/providers/types.ts:43`) é um campo específico do Baileys num
   tipo que deveria ser agnóstico. Vazamento pequeno e tolerável; o `raw?: unknown` já existe
   para isso.
3. **`to_number` do inbound no worker:** `instance.phone_number_id ?? '000000000'`
   (`baileysWorker.ts:320`) — um campo da Meta usado como identificador do nosso lado numa
   instância que, por definição, não tem `phone_number_id`. O sentinela `'000000000'` vai parar
   em `messages.to_number`, e a conversa fica identificada por um número falso. O correto é a
   instância Baileys guardar o **próprio número** (que o socket informa ao conectar) e usá-lo aqui.
4. **`sendTemplate`/`sendCtaUrl` lançam `Error` genérico** no `BaileysProvider` em vez de
   `UnsupportedByProviderError` (que existe e é tratado com 422 na rota). Na prática o
   `capabilities` barra antes, então é defesa em profundidade — mas é a que falha silenciosa
   nasce quando alguém adicionar um caminho novo.
5. **`ProviderCapabilities` é consultada em alguns pontos, não em todos.** Vale um teste que
   percorra toda capability e garanta que existe barreira antes da chamada.
6. **Nível de instância, não de provider:** `META_APP_SECRET` global (L2) e `verifyChallenge`
   varrendo todas as orgs. Não são problemas de `provider.*` — são do webhook — mas aparecem no
   mesmo dia: quando um cliente trouxer o próprio App Meta.

**Nada disso é reescrita.** São ajustes localizados, e o item 1 é o único que merece desenho antes
de código.

### 3.6 Histórico de conversas — NÃO é sincronizado (comportamento esperado)

**Pergunta que isto responde:** "pareei o número, mas o Live Chat mostra 'Sem conversas ainda',
mesmo o WhatsApp tendo conversas antigas. É bug?"

**Não é bug. É o comportamento atual, por omissão de escopo.** O sistema só enxerga mensagens
**recebidas a partir do pareamento** — exatamente como já acontece na Meta Cloud API (V1), que
também não entrega histórico. Uma instância recém-pareada começa com o Live Chat vazio e vai se
preenchendo conforme as pessoas escrevem.

**O que o código faz hoje, verificado linha a linha:**

| Ponto | Estado |
|---|---|
| `syncFullHistory` no `makeWASocket` | **não passamos** (`realSocket.ts:106-112` manda só `auth`, `printQRInTerminal` e `version`) → vale o default da lib, hoje `true` |
| Handler de `messaging-history.set` | **não existe**. O worker registra só `connection.update` e `messages.upsert` (`baileysWorker.ts:286,296`) e `creds.update` (`realSocket.ts:115`) |
| Efeito prático | o WhatsApp pode até mandar o histórico; **ninguém escuta**, então nada chega ao `repo.*` |

Detalhe que engana: `syncFullHistory: true` faz o `requireFullSync` ir no nó de registro
(`Utils/validate-connection.js:79`), mas o `shouldSyncHistoryMessage` default **descarta** o sync
do tipo `FULL` (`Defaults/index.js:65-67`). Ou seja, nem mexendo só nessa flag o histórico
completo apareceria — e, com zero listeners, a discussão é acadêmica.

**Custo de implementar, se um dia for decidido (levantamento, não recomendação):**

O trabalho **não** é criptografia nem paginação manual — a lib resolve isso. O
`downloadAndProcessHistorySyncNotification` baixa, decifra e faz o parse do protobuf, e o evento
chega pronto com `{ chats, contacts, messages, isLatest, progress, chunkOrder, syncType }`
(`Utils/process-message.js:261-276`). O custo real é de **integração**, e tem uma armadilha séria:

1. **Não passar histórico pelo `recordInbound`.** Ele dispara o motor de fluxos
   (`src/domain/inbound.ts:80`) — importar histórico por ali faria o bot **responder a mensagens
   de meses atrás**, disparando fluxos e possivelmente mensagens reais para clientes. O import
   precisa de um caminho próprio, que grava contato/conversa/mensagem **sem** tocar em fluxos.
2. **Volume e chunking.** O evento chega em pedaços, várias vezes, fora de ordem
   (`chunkOrder`), e um número movimentado traz milhares de mensagens — gravar isso num
   `for` sequencial pelo `repo.*` é lento e pode competir com o tráfego ao vivo.
3. **Dedupe.** Já temos `wa_message_id` único por instância; o import precisa usá-lo, senão uma
   segunda sincronização duplica tudo.
4. **Mensagens `fromMe`.** Histórico traz os dois lados; hoje o worker ignora `fromMe`
   (`baileysWorker.ts:298`). Sem tratar, a conversa importada fica só com metade das falas.

**Estimativa: médio** — 1 a 2 dias, dominados pelos itens 1 e 2, não pelo Baileys. A alternativa
barata (e honesta) é **não implementar** e deixar escrito na UI de pareamento que o histórico
anterior não vem junto.

> **Nota adjacente, encontrada na mesma auditoria:** o handler de `messages.upsert` ignora o campo
> `u.type` (`'notify'` vs `'append'`) e processa tudo pelo mesmo caminho. Mensagens que chegam
> enquanto o worker esteve fora entram como inbound normal — o que é desejável — mas é uma
> distinção que não estamos fazendo de propósito, e sim por omissão.

---

## 4. Requisitos não-funcionais (o que este documento assume)

- **Isolamento:** nenhuma request de usuário alcança dado de outra org. O gargalo é
  `requireInstance`; a proteção é ele ser o **único** caminho, e o `orgId` ser obrigatório nele.
- **Sem falha silenciosa:** toda transição relevante (envio, conexão, retomada de fluxo, expiração
  de convite, falha de decifragem) grava resultado — sucesso **e** falha — com motivo. B3 e B4
  eram as violações abertas; ambas fechadas (§1.3).
- **Fail-closed em segredo ausente:** padrão já adotado por `CRON_SECRET` e `META_APP_SECRET`,
  e que deve valer para `PUBLIC_SIGNUP` e para a chave de criptografia.
- **Zero estado em memória na camada web:** inalterado. O worker é a exceção **por desenho** e é a
  única (`baileysWorker.ts:15-18` documenta isso corretamente).
- **Uma réplica do worker,** até que exista partição com lock.
- **Reversibilidade:** a criptografia entra com prefixo de versão e leitura tolerante; o registro
  público entra por env var; nenhuma dessas mudanças é de mão única.

---

## 5. Decisões pendentes do Rafael

Nada abaixo tem resposta técnica óbvia. As correções de bug (B1–B4) e as dívidas (L1–L6) não
entram aqui — são trabalho, não decisão — exceto onde a **forma** da correção depende de você.

> **Atualização:** D2, D3, D5, D6, D7, D8, D9 e D10 **foram decididas** e o que dependia delas já
> está implementado (§6). Continuam abertas: **D1** (onde o worker roda) e **D4** (a estratégia de
> auth foi mantida como JWT Bearer, com os endurecimentos aplicados — só volta à mesa se você
> quiser cookie `httpOnly`).

| # | Decisão | Opções | Minha inclinação |
|---|---|---|---|
| **D1** | **Onde o worker Baileys roda** | Railway / Fly / Render / VPS (§3.2) | Railway no primeiro ano — mas é decisão de custo e de apetite por operação, não técnica |
| **D2** | **Este produto é SaaS para terceiros ou ferramenta de uso próprio?** | Determina se `/register` fica aberto, se convites são prioritários, se `META_APP_SECRET` por org é necessário (L2) e se o modelo N:N (D5) importa | **É a decisão que mais destrava as outras — responda primeiro** |
| **D3** | **Como colocar dono na instância de produção** | A (register adota `org_default`) / B (script) / A+B (§2.4) | **A+B.** Baratos e complementares |
| **D4** | **Estratégia de auth** | Manter JWT Bearer + endurecer / migrar para cookie `httpOnly` / híbrido (§2.3) | **Manter JWT** — o mobile decide; endurecer expiração e revogação |
| **D5** | **Vínculo user↔org** | `users.org_id` 1:1 (atual) / tabela `org_members` N:N | Manter 1:1 até D2 dizer "agências" |
| **D6** | **Meta multi-tenant** | `META_APP_SECRET` global (hoje) / por org, com o cliente trazendo o próprio App Meta | Só vale mexer se D2 = SaaS. É trabalho real no webhook |
| **D7** | **Permissões granulares** | Adiar (papéis nomeados cobrem o próximo degrau) / projetar agora | **Adiar** — mas responda se "agente restrito a uma instância" é requisito, porque isso muda o modelo de dados e precisa entrar antes |
| **D8** | **Criptografia de segredos** | (a) recifrar o que existe **ou** rotacionar token + re-parear QR; (b) onde a chave vive e o que acontece se for perdida (§3.3) | Recifrar + documentar a perda de chave como incidente de recuperação |
| **D9** | **Nomenclatura e schema** | Manter `'meta'` (vs. `meta_cloud` do briefing); manter as 4 colunas nulas + validação discriminada (vs. `config` JSON) | Manter os dois; o ganho não paga a migration |
| **D10** | **Escala do worker** | Uma réplica por convenção (hoje) / partição com lock no banco | Uma réplica até existir um segundo motivo real |

### Ordem sugerida de trabalho, uma vez decidido

1. **B1 + B2** — dono da instância de produção e registro fechado. É o que impede uma perda de
   acesso real, e é o mais barato da lista.
2. **L1** — criptografia (`instances.token`, `verify_token`, `baileys_auth.value`), junto com a
   decisão D8.
3. **B3 + B4** — worker varre instâncias novas; outbox de instância desconectada deixa de
   acumular em silêncio.
4. **L3 + `orgId` obrigatório em `requireInstance`** — integridade do `org_id` e fechamento do
   gargalo de escopo contra regressão futura.
5. **§2.6 convites + L5** — onboarding do segundo usuário, revogação de sessão, remoção de usuário.
6. **§3.5 item 1 e 3** — classificação de erro agnóstica de provider e o número próprio da
   instância Baileys.

D1 (onde o worker roda) não bloqueia 1, 2 e 4 — só o 3, que é onde o worker precisa estar de pé
para valer a pena.

---

## 6. Estado da implementação — rodada P6.1

Decisões tomadas pelo Rafael sobre este documento: **D2** = modelo agência (não self-serve),
**D5** = `org_members` N:N agora, **D7** = sem restrição por instância dentro da conta,
**D8** = recifrar (não rotacionar), **D6/D9/D10** = mantidos como descrito.

### O que entrou em código

| Item | Estado | Onde |
|---|---|---|
| `org_members(org_id,user_id,role)` N:N, com backfill sem perda | ✅ | `migrations/*/010_org_members.sql`, `repo.orgMembers` |
| `users`: `status`, `password_changed_at`, `name`, `last_login_at` | ✅ | mesma migration |
| `users.org_id` mantida como **cache** da conta de entrada (não autoritativa) | ✅ | `src/repo/types.ts` |
| JWT carrega a org **ativa**; middleware confere o vínculo a cada request | ✅ | `src/http/auth.ts` |
| Trocar de conta ativa (reemite o token, validando o vínculo) | ✅ | `POST /api/me/switch-org` |
| **B1** — primeiro registro adota a `org_default` quando ela tem instâncias | ✅ | `src/http/auth.ts` + teste do cenário que faltava |
| **B1** — ferramenta de recuperação por linha de comando | ✅ | `npm run create-owner` |
| **B2** — registro público fail-closed (`PUBLIC_SIGNUP`) | ✅ | `src/config/env.ts`, `src/http/auth.ts` |
| **L3** — `instances.org_id` NOT NULL + FK `ON DELETE RESTRICT`; sem default no adapter | ✅ | `migrations/*/012_*.sql`, adapters |
| **L3** — `requireInstance` com escopo obrigatório + `requireInstanceSystem` | ✅ | `src/http/util.ts` |
| Teste de escopo que cobre **todas** as rotas montadas (não só as principais) | ✅ | `INSTANCE_SCOPED_MOUNTS` + `tests/orgscope.test.ts` |
| Convites (uso único, 72h, papel vindo do convite, revogar/reenviar) | ✅ | `migrations/*/011_invites.sql`, `src/http/team.ts` |
| **L5** — desabilitar usuário e trocar senha derrubam as sessões | ✅ | `POST /api/users/:id/disable`, `POST /api/me/password` |
| **L1/D8** — AES-256-GCM na fronteira do `repo.*` + backfill idempotente | ✅ | `src/util/crypto.ts`, `npm run encrypt-secrets` |
| Campo morto `baileys_session_ref` removido | ✅ | `src/repo/types.ts` |

### O que continua aberto (não fazia parte desta rodada)

- ~~**B3**~~ e ~~**B4**~~ — fechados na rodada do worker (varredura periódica + TTL da outbox);
  ver §1.3. Junto foram: o 405 do handshake (versão do WhatsApp Web resolvida no boot), o estado
  `connecting` no pareamento e o logger próprio do Baileys, que acabou com o
  `error in handling message` sem causa.
- **L2** — `META_APP_SECRET` global (aceito enquanto os WABAs forem todos do mesmo App Meta —
  decisão D6).
- **L6 / D10** — uma réplica de worker por convenção, sem lock no banco.
- **D1** — onde o worker roda (Railway/Fly/VPS) segue sem decisão.
- **§3.5** — classificação de erro agnóstica de provider e número próprio da instância Baileys.

### Decisões de detalhe tomadas dentro do que já foi decidido

1. **`users.org_id` foi mantida** (em vez de removida) como cache da conta de entrada. Remover
   exigiria reconstruir a tabela no SQLite e não traria ganho; o risco de divergência é neutralizado
   porque o login valida o cache contra `org_members` antes de usá-lo.
2. **Revogação de sessão por carimbo, não por `iat`.** A primeira versão comparava
   `iat < password_changed_at`; com granularidade de 1 segundo, token velho e token novo emitidos no
   mesmo segundo ficavam indistinguíveis — a revogação falhava justamente no caso "trocar a senha
   porque ela vazou, agora". O token passou a carregar o `password_changed_at` vigente na emissão e o
   middleware compara por igualdade.
3. **Aceite de convite para e-mail que já tem conta exige a senha ATUAL.** Sem isso, qualquer owner
   poderia convidar o e-mail de um usuário existente, aceitar o próprio convite com uma senha nova e
   tomar a conta — o convite viraria um "esqueci a senha" sem verificação de e-mail.
4. **Convite guarda só o SHA-256 do token**; o link em claro aparece uma única vez na resposta de
   criação/reenvio. O link volta como caminho relativo — montar URL absoluta a partir do header
   `Host` confiaria num valor controlado pelo cliente.
5. **`POST /api/users` (criar usuário com senha escolhida pelo owner) foi REMOVIDA**, não mantida
   como fallback: enquanto ela existisse, seria o caminho mais curto e continuaria sendo usada.
   O fallback administrativo é o `npm run create-owner`, que roda com acesso ao banco.
6. **Backfill de criptografia vive no adapter** (`repo.maintenance`), porque é o único ponto que
   precisa enxergar a forma ARMAZENADA do valor — a camada transparente já devolveria texto claro e a
   verificação de idempotência perderia o sentido.
7. **Sem rota de remover membro** nesta rodada (só desabilitar), para não ampliar escopo. Desabilitar
   já cobre o caso operacional e é reversível.
