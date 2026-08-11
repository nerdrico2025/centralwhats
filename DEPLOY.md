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
| `SECRETS_ENCRYPTION_KEY` | idem (validada no boot; reservada p/ criptografia em repouso — os tokens hoje ficam em texto no banco, protegidos pelo acesso ao Postgres) |
| `CRON_SECRET` | string longa aleatória (`openssl rand -hex 32`) — **obrigatória** para o disparo autônomo de campanhas |

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

⚠️ **Limite do plano Hobby**: cron só roda **1x por dia** (por isso o schedule
commitado é `0 3 * * *`). Um deploy com frequência maior **falha o build
inteiro**. Para o disparo autônomo valer de verdade, escolha uma das opções:

- **Vercel Pro** — troque o schedule para `*/2 * * * *` (o motor foi
  dimensionado para isso: orçamento de 20s por varredura, `maxDuration` 30s).
- **Agendador externo** (mantém o Hobby) — GitHub Actions, cron-job.org etc.
  chamando a mesma rota na frequência que quiser:

```bash
curl -X POST https://SEU-APP.vercel.app/api/cron/tick-campaigns \
  -H "Authorization: Bearer $CRON_SECRET"
```

Enquanto isso não estiver decidido, campanhas continuam avançando por tráfego
de webhook e pelo polling da UI (como no P3.1) — só não avançam sozinhas.

**Fumaça**:
```bash
curl https://SEU-APP.vercel.app/health          # {"ok":true,...}
# navegador: abre o painel; crie a PRIMEIRA conta em Usuários (isso tranca o
# sistema — depois disso, tudo exige login)
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

- [ ] Migrations aplicadas no Supabase (18 tabelas, `org_default` existe)
- [ ] `npm test` verde contra o Postgres (valida o PostgresAdapter)
- [ ] `/health` responde na Vercel
- [ ] **Primeira conta criada** (sistema trancado — sem token = 401)
- [ ] Webhook da Meta verificado + campo `messages` assinado
- [ ] Template sincronizado e enviado com sucesso
- [ ] Live Chat bidirecional (Meta)
- [ ] Fluxo com delay longo retoma sozinho em produção
- [ ] Campanha pequena (10–20 contatos) com falhas visíveis em `campaign_sends`
- [ ] Worker: QR pareado, mensagem via outbox entregue, restart sem re-parear
- [ ] APK instalado, agent logado, resposta chegando no web

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
