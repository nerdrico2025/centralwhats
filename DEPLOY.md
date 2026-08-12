# DEPLOY.md — Guia de produção do WA Manager

Passo a passo para colocar tudo em produção e executar as validações externas
pendentes. Ordem recomendada: **Supabase → Vercel → Meta → Railway (worker) →
Mobile**. Cada seção termina com um teste de fumaça.

```
┌───────────────────────────┐         ┌──────────────────────────┐
│  VERCEL (serverless)       │         │  META (WhatsApp Cloud)    │
│  painel + REST + webhook   │◄────────│  webhooks de mensagem     │
│  api/index.ts (waitUntil)  │────────►│  Graph API (envios)       │
└─────────────┬─────────────┘         └──────────────────────────┘
              │
              ▼ (mesmo Postgres)
      ┌───────────────┐          ┌───────────────────────────────┐
      │   SUPABASE    │◄─────────│  RAILWAY — worker Baileys      │
      │   (Postgres)  │          │  sempre-ligado (QR + outbox)   │
      └───────────────┘          └───────────────────────────────┘
              ▲
              │ REST API
      ┌───────────────┐
      │  MOBILE (APK) │  cliente fino p/ atendentes
      └───────────────┘
```

---

## 1. Supabase (Postgres)

1. Crie um projeto em [supabase.com](https://supabase.com) (região próxima, ex.: `sa-east-1`).
2. Em **Settings → Database**, anote as DUAS connection strings:
   - **Transaction pooler (porta 6543)** → usada pela Vercel (serverless abre
     muitas conexões curtas; o pooler evita esgotar o Postgres). Acrescente
     `?pgbouncer=true` se não vier.
   - **Direct (porta 5432)** → usada para migrations e pelo worker (conexão
     longa única).
3. Rode as migrations **da sua máquina**, apontando para a conexão direta:

```bash
DB_DRIVER=postgres DATABASE_URL='postgres://postgres:SENHA@db.xxxx.supabase.co:5432/postgres' \
  npm run migrate
```

O log deve confirmar o alvo ANTES de rodar:
```
Rodando migrations em: postgres @ db.xxxx.supabase.co:5432/postgres
Migrations concluídas em: postgres @ db.xxxx.supabase.co:5432/postgres
```
Se aparecer `sqlite` aqui, a env não chegou ao processo — o script agora
aborta com erro em vez de migrar o banco errado.

> **Rede sem IPv6?** A conexão direta `db.xxxx.supabase.co` é IPv6-only em
> muitos planos. Se der `ENETUNREACH`/timeout, use a string do **Session
> pooler** (Settings → Database → em "Connection string", modo *Session*, host
> `aws-0-<região>.pooler.supabase.com:5432`) — serve para migrations e worker.

4. *(Recomendado — valida o PostgresAdapter de verdade)* rode a suíte contra o
   Postgres uma vez:

```bash
DB_DRIVER=postgres DATABASE_URL='postgres://...:5432/postgres' npm test
```

**Fumaça**: no painel do Supabase (Table Editor), as ~18 tabelas devem existir
(`instances`, `messages`, `flows`, `outbox`, `baileys_auth`, `orgs`, `users`…),
e `orgs` deve ter a linha `org_default`.

---

## 2. Vercel (painel + API + webhook)

O repositório já traz o adaptador serverless:
- `api/index.ts` — exporta o app Express; o processamento em background do
  webhook usa `waitUntil()` (a function não morre antes de terminar, sem
  atrasar o 200 da Meta).
- `vercel.json` — reescreve todas as rotas para a function e roda `npm run build`.

Passos:
1. Suba o repositório para o GitHub e importe na [vercel.com](https://vercel.com)
   (framework: **Other**; as configs vêm do `vercel.json`).
2. Em **Settings → Environment Variables** (Production):

| Variável | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `DB_DRIVER` | `postgres` |
| `DATABASE_URL` | connection do **pooler (6543)** |
| `JWT_SECRET` | string longa aleatória (`openssl rand -hex 32`) |
| `SECRETS_ENCRYPTION_KEY` | idem — **cifra de verdade** os segredos em repouso (token/verify_token da Meta e sessão do Baileys). Precisa ser **a MESMA** na Vercel e no worker (Railway). Ver §7 |
| `PUBLIC_SIGNUP` | **não defina** (ausente = registro público FECHADO). Só ligue (`true`) se quiser que qualquer pessoa crie conta pela tela de login — no modelo agência, usuário novo entra por convite |
| `CRON_SECRET` | string longa aleatória (`openssl rand -hex 32`) — **obrigatória** para o disparo autônomo de campanhas |
| `META_APP_SECRET` | App Secret do app da Meta — **obrigatória**: sem ela o webhook recusa todo evento (ver abaixo) |

### Assinatura do webhook (segurança)

O `POST /webhook` valida `X-Hub-Signature-256`: a Meta assina o corpo bruto de
cada evento com HMAC-SHA256 usando o **App Secret**. Sem isso, qualquer um com
a URL do webhook fabricaria "mensagem recebida" com remetente e texto
arbitrários — e, com um fluxo de chatbot ativo, provocaria **envio real** de
mensagem (custo na conta Meta) além de gravar contato/mensagem/CRM falsos.

Onde pegar: **Meta App Dashboard → Configurações do app → Básico → Chave
secreta do aplicativo**. Não confundir com:
- `verify_token` — por instância, só valida o `GET` de verificação inicial;
- token de acesso — por instância, autentica as chamadas de envio.

⚠️ **É fail-closed**: sem `META_APP_SECRET` definida, **todo POST é recusado
com 401** e nenhuma mensagem recebida é processada. Defina a variável na Vercel
**antes** de subir a versão que traz esta validação.

```bash
curl -sI https://SEU-APP.vercel.app/webhook -X POST   # 401 = sem segredo ou sem assinatura
```

3. Deploy. A URL final (ex.: `https://wa-manager.vercel.app`) é a base de tudo.

### Cron de campanhas (P3.2)

`vercel.json` §`crons` agenda `GET /api/cron/tick-campaigns`, que avança as
campanhas `running` de todas as instâncias sem depender de tráfego de webhook
nem da UI aberta.

A rota é protegida por `CRON_SECRET`: a Vercel injeta
`Authorization: Bearer $CRON_SECRET` nas chamadas agendadas. **Sem a variável
definida a rota responde 503 e não processa nada** — de propósito: esta rota
dispara envio real, e um deploy sem o segredo não pode virar um endpoint
público de disparo em massa.

⚠️ **Limite do plano Hobby**: o cron da Vercel só roda **1x por dia**, e um
deploy com frequência maior **falha o build inteiro** (aconteceu em `c0f6ec7`).
Por isso o schedule commitado é `0 3 * * *` — rede de segurança diária, só.

**Quem dá o ritmo de verdade é o GitHub Actions**:
`.github/workflows/tick-campaigns.yml` chama a mesma rota a cada 5 minutos
(mínimo do Actions; é best-effort, atrasa alguns minutos sob carga — sem
problema, a campanha é retomável).

Configuração (uma vez):

```bash
# 1. Gere o segredo
openssl rand -hex 32

# 2. MESMO valor nos dois lados:
#    - Vercel → Settings → Environment Variables → CRON_SECRET
#    - GitHub:
gh secret set CRON_SECRET

# 3. Teste na mão (Actions → "Tick de campanhas" → Run workflow), ou:
curl -X POST https://SEU-APP.vercel.app/api/cron/tick-campaigns \
  -H "Authorization: Bearer $CRON_SECRET"
```

O workflow **falha alto** se o segredo estiver ausente (503) ou divergente
entre GitHub e Vercel (401) — nunca fica passando em verde sem disparar nada.

Se um dia migrar para o **Vercel Pro**, dá para trocar o schedule do
`vercel.json` para `*/2 * * * *` e desligar o workflow: o motor foi
dimensionado para isso (orçamento de 20s por varredura, `maxDuration` 30s).

Sem nada disso configurado, campanhas ainda avançam por tráfego de webhook e
pelo polling da UI aberta (como no P3.1) — só não avançam sozinhas.

**Fumaça**:
```bash
curl https://SEU-APP.vercel.app/health          # {"ok":true,...}
# navegador: abre o painel e crie a PRIMEIRA conta na tela de login. Isso
# tranca o sistema (depois disso tudo exige login) E, se já houver instância na
# org_default, a nova conta ADOTA essa org — as instâncias/conversas que já
# existiam continuam visíveis. Confira isso ANTES de seguir (ver §7).
```

---

## 3. Meta (WABA — API Oficial)

1. Em [developers.facebook.com](https://developers.facebook.com): crie um app
   **Business** → adicione o produto **WhatsApp**.
2. Anote do painel do WhatsApp: **`phone_number_id`** e **`waba_id`**.
3. **Token permanente** (o token de teste expira em 24h): em
   [business.facebook.com](https://business.facebook.com) → Configurações do
   negócio → Usuários do sistema → crie um system user **admin** → gere token
   com os escopos `whatsapp_business_messaging` e `whatsapp_business_management`
   → vincule o app e o WABA ao system user.
4. **No painel do WA Manager** (já logado): Instâncias → Nova instância →
   provider **API Oficial (Meta)** → preencha `phone_number_id`, `waba_id`,
   token e um `verify_token` que você inventar (ex.: `openssl rand -hex 12`).
5. **Webhook** no app da Meta (WhatsApp → Configuration):
   - Callback URL: `https://SEU-APP.vercel.app/webhook`
   - Verify token: o MESMO da instância (a verificação casa pelo token).
   - Clique **Verify and save** → deve validar (é o GET /webhook).
   - Em **Webhook fields**, assine **`messages`**.

**Fumaça**:
1. Templates → **Sincronizar da Meta** → os templates aparecem com o idioma
   cadastrado lá.
2. Disparar Mensagem → template `hello_world` (ou um seu) para o SEU número →
   chega no WhatsApp.
3. Responda a mensagem no celular → a conversa aparece no **Live Chat** com
   não-lida; responda pelo painel → chega no celular.
4. Crie um fluxo no **Chatbot** com `trigger_keyword`, ative, mande a keyword
   pelo celular → o bot responde (inclusive retomando delays longos).

---

## 4. Railway (worker Baileys — V2)

O worker é um processo sempre-ligado que compartilha o MESMO Postgres.

1. Em [railway.app](https://railway.app): New Project → **Deploy from GitHub
   repo** (o mesmo repositório).
2. Em **Settings** do serviço:
   - Build command: `npm install && npm run build`
   - Start command: `npm run worker:prod`
3. **Variables**:

| Variável | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `DB_DRIVER` | `postgres` |
| `DATABASE_URL` | connection **direta (5432)** — o worker mantém 1 conexão viva |
| `JWT_SECRET` / `SECRETS_ENCRYPTION_KEY` | os mesmos da Vercel |

4. Deploy. O log deve mostrar `[worker] Baileys worker rodando`.
5. **Parear um número**: no painel → Instâncias → Nova instância → provider
   **Baileys** → salvar → botão **QR** → o worker gera o QR em ~5s → escaneie
   no celular (WhatsApp → Aparelhos conectados). O status vira `connected`.

> Alternativa ao Railway: Fly.io ou qualquer VPS (`pm2 start npm -- run
> worker:prod`). O único requisito é ser sempre-ligado e alcançar o Postgres.

**Fumaça**:
1. Mande "oi" de outro número para o número pareado → aparece no Live Chat.
2. Responda pelo painel → o envio entra na `outbox`, o worker consome (~2s) e a
   mensagem chega (status `queued → sent` no banco).
3. Fluxo com trigger keyword funciona igual ao da Meta (mesmo motor).
4. **Teste de resiliência**: restart do serviço no Railway → o worker reconecta
   sozinho SEM QR novo (sessão persistida no banco).

---

## 5. Mobile (APK via EAS)

```bash
cd mobile
# 1. Aponte a API de produção:
#    app.json → expo.extra.apiUrl = "https://SEU-APP.vercel.app"
npm install
npx expo start                     # teste rápido no Expo Go (mesma rede)

# 2. Build do APK:
npm install -g eas-cli
eas login                          # conta Expo (gratuita)
eas build -p android --profile preview
# → baixa o .apk do link ao final e instala no aparelho
```

**Fumaça**: login com um usuário `agent` (crie no painel em Usuários) → vê só
as conversas da org dele → responde → a resposta aparece no Live Chat web.

---

## 6. Checklist final

- [ ] Node **22.x** nos três lugares: `.nvmrc`, `engines` e painel da Vercel (§6.1)
- [ ] `npm run audit-instances` sem órfãs **antes** de migrar (ver §7)
- [ ] Migrations aplicadas no Supabase (~21 tabelas: + `org_members`, `invites`)
- [ ] `npm test` verde contra o Postgres (valida o PostgresAdapter)
- [ ] `/health` responde na Vercel
- [ ] **Primeira conta criada** e as instâncias antigas continuam visíveis nela
- [ ] `npm run encrypt-secrets` rodado DEPOIS do deploy (§7) e painel/worker OK
- [ ] Webhook da Meta verificado + campo `messages` assinado
- [ ] Template sincronizado e enviado com sucesso
- [ ] Live Chat bidirecional (Meta)
- [ ] Fluxo com delay longo retoma sozinho em produção
- [ ] Campanha pequena (10–20 contatos) com falhas visíveis em `campaign_sends`
- [ ] Worker: QR pareado, mensagem via outbox entregue, restart sem re-parear
- [ ] APK instalado, agent logado, resposta chegando no web

## 6.1 Versão de Node — FIXADA, e nos três lugares

O projeto roda em **Node 22.x** (LTS "Jod"). Isso não é preferência: é
requisito e é convergência.

**Por que 22 e não a LTS mais nova (24):**
- `node:sqlite`, usado pelo adapter de desenvolvimento, só existe a partir do
  **Node 22.5**. Abaixo disso o processo nem carrega o módulo.
- O Baileys pede `>=20` — coberto.
- A Vercel oferece 24.x, 22.x e 20.x. O builder do Railway, pela evidência do
  log real (`Node.js v20.20.2` com `engines: ">=20"`), **não estava servindo
  24** — e o Nixpacks, quando não consegue resolver a versão pedida, cai em
  silêncio no default dele (**Node 18**), que é pior que o problema original.
  22 é o major mais novo que os três ambientes garantidamente entregam.
- Quando um build do Railway confirmar que 24 está disponível lá, mover é
  trocar `22` por `24` nos dois arquivos abaixo. Não antes.

**Onde a versão está fixada (mudou um, mude todos):**

| Lugar | Valor | Quem lê |
|---|---|---|
| `.nvmrc` | `22` | `nvm use` local; Railway/Nixpacks (3ª na ordem de precedência) |
| `package.json` → `engines.node` | `22.x` | **Vercel** (sobrepõe o Node.js Version do painel) e Railway/Nixpacks (2ª na precedência, vence o `.nvmrc`) |
| Painel da Vercel → Settings → Build and Deployment → **Node.js Version** | `22.x` | fallback quando o `engines` não existe — **confira na mão** |
| Railway → Variables → `NIXPACKS_NODE_VERSION` *(opcional)* | `22` | 1ª na precedência; use se o build lá insistir noutra versão |

**`vercel.json` não entra nessa lista de propósito:** o schema oficial
(`https://openapi.vercel.sh/vercel.json`) **não tem** campo `nodeVersion` — só
`bunVersion`. Inventar a chave faria a validação do deploy falhar. Na Vercel, o
mecanismo de pinning é o `engines.node`, que por documentação sobrepõe a seleção
do painel.

**Só o major é fixável.** Vercel e Nixpacks instalam "a última 22.x" e aplicam
patches sozinhos; por isso o `.nvmrc` traz `22`, e não um patch exato — pinar
`22.23.2` daria uma precisão falsa que nenhum dos dois honra, e ainda faria o
local divergir dos servidores a cada patch de segurança.

**Sintoma de que isto saiu do lugar:** `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`
no boot (Node < 22.5), ou comportamento que difere entre painel e worker sem
explicação. O primeiro passo do diagnóstico é `node -v` nos dois ambientes.

---

## 7. Multi-tenancy e criptografia (P6.1) — ORDEM DE DEPLOY

Esta rodada mexe em schema, em auth e em como os segredos são gravados. A
ordem abaixo não é sugestão: cada passo depende do anterior.

**1. Auditoria (antes de qualquer migration).** A migration 012 torna
`instances.org_id` NOT NULL com FK — instância órfã faz ela falhar de
propósito:

```bash
DB_DRIVER=postgres DATABASE_URL='postgres://...:5432/postgres' npm run audit-instances
# "OK — N instância(s), todas com org válida" → pode seguir
```

**2. Migrations** (`010` org_members + campos de `users`, `011` invites,
`012` NOT NULL/FK). Use a connection **direta (5432)**:

```bash
DB_DRIVER=postgres DATABASE_URL='postgres://...:5432/postgres' npm run migrate
```

A 010 copia TODO vínculo de `users.org_id` para `org_members` — ninguém perde
acesso. `users.org_id` continua existindo, mas vira só cache da conta de
entrada; a fonte da verdade passa a ser `org_members`.

**3. Deploy do código** (Vercel + Railway). Só agora, porque o código novo lê
`org_members` e as colunas criadas no passo 2.

**4. Primeiro owner.** Pela tela de login (o primeiro registro adota a
`org_default` se ela tiver instâncias) ou, se algo já tiver saído do trilho:

```bash
DB_DRIVER=postgres DATABASE_URL='postgres://...' \
  npm run create-owner -- --email=voce@dominio.com --password='...' --org=org_default
```

Entre no painel e confirme que as instâncias/conversas antigas aparecem.
**Não siga para o passo 5 antes disso.**

**5. Backfill da criptografia — DEPOIS do deploy, nunca antes.** A leitura é
tolerante (valor sem o prefixo `enc:` é lido como texto claro), então o sistema
funciona nos dois estados e não há janela de indisponibilidade:

```bash
DB_DRIVER=postgres DATABASE_URL='postgres://...' \
  SECRETS_ENCRYPTION_KEY='<a MESMA da Vercel e do Railway>' npm run encrypt-secrets
```

É idempotente: rodar duas vezes não cifra duas vezes (a segunda execução só
conta "já cifradas"). Depois, confira o painel (envio funcionando) e o worker
(sessão Baileys conectada).

### Sobre a `SECRETS_ENCRYPTION_KEY`

- Cifra `instances.token`, `instances.verify_token` e `baileys_auth.value`
  (AES-256-GCM, prefixo `enc:v1:`).
- **A MESMA chave na Vercel e no Railway.** Chaves diferentes = o worker não lê
  a sessão que a web gravou, e vice-versa (erro alto, `SecretDecryptError` —
  nunca falha em silêncio).
- **Perder a chave torna os dados cifrados irrecuperáveis.** A recuperação é
  manual: re-cadastrar o token da Meta na instância e re-escanear o QR do
  Baileys. Guarde-a fora do repositório (gerenciador de senhas).
- Rotação de chave ainda não é automática: o prefixo de versão existe
  justamente para permitir isso depois sem quebrar o que já está gravado.

---

## Troubleshooting

| Sintoma | Causa provável |
|---|---|
| Webhook "verify failed" na Meta | `verify_token` da instância ≠ o digitado na Meta, ou instância inativa |
| Mensagens da Meta não chegam | Campo `messages` não assinado; ou `phone_number_id` da instância diferente do payload |
| Template rejeitado em silêncio | Idioma errado — use SEMPRE o sincronizado (o painel já força isso) |
| `429/131056` em campanha | Rate-limit da Meta — o motor já retenta sozinho; aumente `interval_ms` |
| Vercel: `too many connections` no Postgres | `DATABASE_URL` sem pooler — use a porta **6543** na Vercel |
| Worker desconecta e não volta | Veja o log: `statusCode 401` = logout no celular (re-parear via QR); outros códigos reconectam com backoff |
| Painel abre sem pedir login | Modo bootstrap: nenhum usuário criado ainda — crie a primeira conta |
| Depois de criar a conta, o painel não mostra as instâncias antigas | A conta nasceu numa org nova em vez de adotar a `org_default`. Rode `npm run create-owner -- --email=... --password=... --org=org_default` e entre com esse usuário |
| `SecretDecryptError` no painel ou no worker | `SECRETS_ENCRYPTION_KEY` diferente da que gravou o dado. Use a MESMA na Vercel e no Railway — chave perdida = token/sessão irrecuperáveis (§7) |
| `403 Registro público desabilitado` | Comportamento esperado: convide o usuário pela tela **Equipe**, ou defina `PUBLIC_SIGNUP=true` |
| Convite dá "já foi utilizado" | Token é de uso único; use **Reenviar** na tela Equipe para gerar um link novo |
