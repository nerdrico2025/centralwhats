# CLAUDE.md — Regras do projeto WA Manager

Este arquivo é lido automaticamente pelo Claude Code em toda sessão. As regras abaixo são
**inegociáveis** e derivam de bugs reais de produção. Se um prompt pedir algo que contradiz uma
regra aqui, **pare e aponte o conflito** antes de codar.

Contexto completo do produto está em `01_PLANO_E_ARQUITETURA.md`. Leia-o antes de tarefas grandes.

---

## Stack e estilo
- **TypeScript** em backend e worker. Frontend SPA leve (Vanilla/Preact/Svelte).
- Backend Node.js + Express (ou Hono). Banco Postgres (prod) / SQLite (dev).
- Commits pequenos e focados. Cada função de negócio testável isoladamente.
- Português na UI e nas mensagens ao usuário. Código e comentários podem ser em português.

## As DUAS abstrações obrigatórias (nunca fure)
1. **`repo.*`** — todo acesso a dados passa por aqui. **Nenhum SQL cru fora dos adapters**
   (`SqliteAdapter`, `PostgresAdapter`). Trocar de banco não pode tocar em lógica de negócio.
2. **`provider.*`** — todo envio de mensagem passa por aqui (`sendText`, `sendMedia`,
   `sendTemplate`, `sendButtons`, `sendList`, `sendReaction`). Implementações: `MetaCloudProvider`
   (V1) e `BaileysProvider` (V2). **Nenhum módulo de negócio chama a Graph API ou o Baileys
   diretamente** — só `provider.*`. O dispatcher escolhe a implementação pelo `provider_type` da
   instância.

## Serverless / estado (o mais importante)
- **Zero estado em memória entre requisições.** Cada request pode rodar em outro processo. Tudo que
  precisa ser lembrado (mesmo por segundos) vai pro banco.
- **Proibido `setInterval`/`setTimeout` global** para segurar trabalho futuro. Nada de function
  esperando minutos.
- **Webhook responde HTTP imediatamente.** Processamento pesado (fluxo, retomada de delay, campanha)
  roda em background. Deduplicar por `wa_message_id` (idempotência).

## Disparo em massa
- **Logue TODO envio** (sucesso E falha) em `campaign_sends`, com `error_code`/`error_message`.
  Proibido o padrão "só grava se deu certo".
- Use **`Promise.allSettled`**, nunca `Promise.all`, em lotes de envio.
- **Intervalo configurável** entre envios (UI decide). Sem paralelismo agressivo por padrão — o teto
  de throughput é por número, do lado da Meta.
- **Retry só em rate-limit** (ex.: `130429`, `131056`) com espera. **Sem retry** em erro permanente
  (ex.: número inválido).
- Campanha grande é **retomável em lotes**, nunca uma request só (timeout serverless).

## Motor de fluxos (as 5 lições)
1. **Delay:** nunca `await sleep(longo)`. Resolva a próxima aresta, grave `current_node_id` +
   `next_step_at = agora + s`, **retorne sem esperar**. `processPendingExecutions()` retoma.
   Disparado pelo tráfego de webhook (varredura em background por instância).
2. **Delay híbrido:** abaixo de ~10s, dormir inline; acima, persistir e retomar (senão o bot parece
   "preso" esperando o lead).
3. **Contadores atômicos:** estado lembrado entre execuções (ex.: Randomizador round-robin) só muda
   por **UMA instrução SQL atômica** (`UPDATE ... SET counter=(counter+1)%N ... RETURNING counter`).
   Nunca ler→somar→salvar em passos separados.
4. **Editar fluxo ao vivo:** se uma retomada não encontra o `current_node_id` (nó apagado/recriado),
   **logue/avise** — nunca cancele em silêncio. Prefira editar conteúdo do nó a apagar+recriar.
5. **Trava de fluxo:** bloqueie novo fluxo por **(fluxo + contato)**, NÃO por contato+instância
   inteira (senão uma execução presa em qualquer fluxo antigo sequestra o contato). Tenha
   limpeza/timeout de execuções presas.

## Integração Meta
- **Idioma do template = o cadastrado na Meta.** Nunca assumir `pt_BR`. Mismatch faz a Meta rejeitar
  em silêncio.
- Webhook identifica a instância pelo **`phone_number_id` do payload**, não pela URL.
- No status "failed", **grave `errors[].code` e `errors[].message`**. Não descarte.
- `profile.name` pode não vir (privacidade) — tenha plano B (pedir nome via conversa).
- Telefone sempre **normalizado** antes de gravar/comparar.

## Frontend
- **Cache-busting obrigatório** em JS/CSS estáticos (hash no nome ou `?v=N`). Nome fixo = browser
  roda código velho.
- Live Chat: **`grid-template-rows` explícito** no container da conversa (senão a área de mensagens
  cresce sem limite e empurra o composer pra fora da tela).
- Seguir o layout de `01_PLANO_E_ARQUITETURA.md` §12 (sidebar escura, verde WhatsApp de acento).

## Multi-tenancy
- V1: toda query escopada por `instance_id`.
- V2: adicionar `org_id`. **Nunca** operar cross-instância/cross-org sem intenção explícita.

## Ao terminar qualquer tarefa
- Diga o que foi feito, o que ficou pendente e como testar.
- Se tocou em fluxo/campanha/delay, confirme explicitamente qual das regras acima foi respeitada.
