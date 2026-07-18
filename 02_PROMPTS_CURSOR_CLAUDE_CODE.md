# Prompts de desenvolvimento — Cursor + Claude Code

Sequência de prompts prontos pra colar, na ordem. Cada prompt assume que `CLAUDE.md` e
`01_PLANO_E_ARQUITETURA.md` estão na raiz do repo (o Claude Code lê o `CLAUDE.md` sozinho).

## Como usar
1. Comece a fase 0. **Não pule ordem** — cada prompt depende do anterior.
2. Depois de cada prompt, revise o diff no Cursor antes de aceitar. Rode os critérios de aceite.
3. Se o agente propuser algo que fura uma regra do `CLAUDE.md`, ele deve avisar; se não avisar, você
   avisa e pede correção.
4. Um prompt = idealmente um PR pequeno. Se ficar grande demais, peça pra dividir.

> **Dica de fixação:** comece toda sessão nova com "Leia `CLAUDE.md` e `01_PLANO_E_ARQUITETURA.md`
> antes de agir. Não fure nenhuma regra do `CLAUDE.md`." O Claude Code lê o `CLAUDE.md`
> automaticamente, mas reforçar não custa.

---

# FASE 0 — Fundação

## P0.1 — Esqueleto do projeto + abstrações

```
Leia CLAUDE.md e 01_PLANO_E_ARQUITETURA.md antes de começar.

Crie o esqueleto do projeto WA Manager em TypeScript. Objetivo desta tarefa: estrutura de pastas,
configuração e os ESQUELETOS das duas abstrações centrais (repo.* e provider.*). NÃO implemente
lógica de negócio ainda — só interfaces, tipos e stubs que compilam.

Requisitos:
1. Estrutura de monorepo simples (ou pastas bem separadas):
   /src
     /config      -> env, seleção de adapters
     /repo        -> interfaces + adapters (sqlite, postgres)
     /providers   -> interface Provider + MetaCloudProvider (stub), BaileysProvider (stub p/ V2)
     /domain      -> lógica de negócio pura (fluxos, campanhas) — vazio por ora
     /http        -> Express app, rotas (vazias), webhook (vazio)
     /web         -> frontend estático (vazio)
   /migrations
2. Defina a interface `Repo` com os sub-repos listados no CLAUDE.md/plano (instances, messages,
   contacts, templates, tags, crm, lists, campaigns, flows, flowExecutions, flowNodeCounters).
   Cada método tipado, corpo lançando "not implemented". Um factory `getRepo()` escolhe o adapter
   por env (DB_DRIVER=sqlite|postgres).
3. Defina a interface `Provider` (sendText, sendMedia, sendTemplate, sendButtons, sendList,
   sendReaction) + `provider.capabilities`. Crie o factory `getProvider(instance)` que escolhe a
   implementação por `instance.provider_type`. MetaCloudProvider e BaileysProvider apenas como
   stubs que lançam "not implemented".
4. Config por variáveis de ambiente com validação (ex.: zod). Inclua `.env.example`.
5. Scripts npm: dev, build, lint, test, migrate.
6. Setup de teste (vitest ou jest) com 1 teste trivial passando.

Critério de aceite: `npm run build` compila, `npm test` passa, nada de SQL nem chamadas externas
implementadas ainda. Explique a estrutura criada ao final.
```

## P0.2 — Camada de dados (migrations + adapters)

```
Leia CLAUDE.md. Implemente a camada de dados completa por trás de repo.*.

1. Migrations para TODAS as tabelas da seção "Modelo de dados" do plano (sem as marcadas [V2]).
   Escreva de forma que rodem tanto em SQLite quanto em Postgres (ou tenha um conjunto por driver se
   necessário — mas a interface repo.* é idêntica).
2. Implemente SqliteAdapter e PostgresAdapter para todos os métodos do Repo. SQL cru vive SÓ aqui.
3. Toda operação de leitura/escrita que envolve dados de tenant recebe e filtra por instance_id.
   Métodos que não filtram por instância devem ser exceção justificada.
4. Implemente o counter atômico do Randomizador como método dedicado:
   repo.flowNodeCounters.incrementAndGet(flowId, nodeId, n) -> number,
   usando UMA instrução SQL atômica (UPDATE ... RETURNING). Escreva um teste de concorrência que
   dispara N incrementos "simultâneos" e verifica que não há valor duplicado/pulado.
5. Normalização de telefone: uma função utilitária única usada por todo o repo de contatos/mensagens.

Critério de aceite: migrations rodam limpas em SQLite; testes de repo passam; teste de concorrência
do contador passa; nenhum SQL cru fora dos adapters.
```

---

# FASE 1 — Núcleo (API Oficial)

## P1.1 — Instâncias (multi-WABA)

```
Leia CLAUDE.md. Implemente o módulo de Instâncias.

1. CRUD de instâncias via repo.instances: name, provider_type (default 'meta'), phone_number_id,
   waba_id, token, verify_token, active, connection_status.
2. Rotas REST em /http: GET /instances, POST /instances, PATCH /instances/:id, DELETE /instances/:id.
3. Token e verify_token nunca retornam pro client em texto claro (mascare na resposta).
4. Um resolvedor: dado um phone_number_id (vindo do webhook), retorna a instância correta.
   Lembre: o webhook identifica a instância pelo phone_number_id do payload, não pela URL.

Critério de aceite: consigo criar 2 instâncias, listar (com token mascarado) e resolver por
phone_number_id. Testes cobrindo o resolvedor.
```

## P1.2 — Webhook de recebimento (verify + inbound + status)

```
Leia CLAUDE.md, com atenção às regras de webhook e serverless.

Implemente o webhook da Meta Cloud API:
1. GET /webhook: verificação do desafio (hub.mode/hub.verify_token/hub.challenge) usando o
   verify_token da instância. Responder o challenge quando válido.
2. POST /webhook: responder 200 IMEDIATAMENTE. Todo processamento roda em background (ex.: função
   processInboundPayload chamada sem bloquear a resposta). Deduplicar por wa_message_id.
3. Parse de mensagens recebidas: texto, mídia, botão, interativo, localização. Para cada uma:
   grava em messages (direction=in), atualiza contacts.last_seen, cria/atualiza crm_contacts,
   captura profile.name quando presente (plano B documentado quando ausente).
4. Parse de status (sent/delivered/read/failed): atualiza messages.status pelo wa_message_id.
   No status 'failed', GRAVE errors[].code e errors[].message em error_code/error_message. Não
   descarte.
5. Ao final do processamento de QUALQUER inbound, dispare em background a varredura
   processPendingExecutions() para aquela instância (stub por enquanto — o motor de fluxos vem na
   fase 4). Deixe o gancho pronto.

Critério de aceite: com payloads de exemplo (inbound de texto, inbound de mídia, status delivered,
status failed com erro), tudo é gravado corretamente; a resposta HTTP não espera o processamento;
duplicatas por wa_message_id são ignoradas.
```

## P1.3 — Provider Meta + envio de mensagens

```
Leia CLAUDE.md. Implemente MetaCloudProvider (a implementação real da interface Provider) e as rotas
de envio.

1. MetaCloudProvider chamando a Graph API para: sendText, sendMedia (imagem/vídeo/áudio/documento),
   sendTemplate (HSM), sendButtons (reply buttons), sendList (lista interativa), sendReaction,
   e CTA/URL. Preencha provider.capabilities marcando o que a oficial suporta.
2. Toda saída também é gravada em messages (direction=out) com wa_message_id retornado pela Meta e
   status inicial.
3. Rotas: POST /instances/:id/messages (envio avulso, todos os tipos). O handler resolve a instância,
   chama getProvider(instance).sendX(...). NUNCA chama a Graph API direto.
4. Tratamento de erro: capture code/message da resposta da Meta e grave em error_code/error_message
   da mensagem de saída. Retorne erro estruturado pro client.
5. IMPORTANTE (templates): use SEMPRE o idioma exato do template cadastrado na Meta. Nunca fixe
   pt_BR. (A sincronização de templates vem em P1.4; por ora, receba o language como parâmetro.)

Critério de aceite: consigo enviar cada tipo de mensagem por uma instância real (ou mock da Graph
API nos testes); cada envio gera um registro em messages; erros da Meta ficam gravados.
```

## P1.4 — Sincronização de Templates

```
Leia CLAUDE.md. Implemente a sincronização de templates aprovados da Meta.

1. Função syncTemplates(instance): busca templates da WABA via Graph API e faz upsert em templates
   (name, category MARKETING/UTILITY/AUTHENTICATION, language, status, components/variáveis,
   wa_template_id).
2. Rota POST /instances/:id/templates/sync e GET /instances/:id/templates.
3. O idioma cadastrado na Meta é a fonte da verdade: ao enviar um template depois, o sistema usa o
   language vindo daqui. Garanta que o envio (P1.3) leia o language do template sincronizado, não um
   default.

Critério de aceite: após sync, os templates aparecem com idioma correto; um envio de template usa o
idioma do registro sincronizado. Teste com um template multi-idioma cobrindo o risco de mismatch.
```

## P1.5 — Contatos, Tags e CRM

```
Leia CLAUDE.md. Implemente Contatos, Tags e CRM.

1. Contatos: listar/buscar por instância, telefone normalizado, nome (do profile.name ou definido
   manualmente), last_seen.
2. Tags: CRUD, aplicar/remover em contato, e APLICAÇÃO EM MASSA (aplicar/remover tag a um conjunto
   de contatos numa operação).
3. CRM: estágio do lead (lead/qualificado/cliente/etc. — configurável), notas, campos customizados
   (custom_fields json), score.
4. Rotas REST correspondentes, todas escopadas por instance_id.

Critério de aceite: consigo criar tags, aplicar em massa, mover um contato de estágio no CRM e
salvar campos customizados. Testes das operações em massa.
```

---

# FASE 2 — Frontend + Live Chat + Dashboard

## P2.1 — Shell do frontend (SPA + layout de referência)

```
Leia CLAUDE.md §Frontend e 01_PLANO_E_ARQUITETURA.md §12.

Construa o shell da SPA seguindo o layout do print de referência:
1. Sidebar escura (navy/quase-preto) com logo verde "WA Manager / API Oficial Meta" e as seções:
   PRINCIPAL (Dashboard, Instâncias), ENVIOS (Disparar Mensagem, Disparo em Massa, Templates),
   ATENDIMENTO (Live Chat com badge de não-lidas, Chatbot), MARKETING (Listas, CRM, Campanhas),
   ANÁLISE (Relatórios, Faturamento). Item ativo em verde WhatsApp (~#25D366).
2. Topbar: seletor de instância (troca o contexto de instance_id de todas as telas), status Online,
   botão Sair.
3. Roteamento client-side simples entre as telas (placeholders por enquanto).
4. CACHE-BUSTING obrigatório nos assets (hash no nome do arquivo ou ?v=BUILD). Documente como o
   build gera a versão.
5. Camada de API client (fetch) que sempre injeta o instance_id atual.
6. Design system mínimo: cards brancos com sombra sutil, fundo claro, verde de acento, tipografia
   limpa. Componentes reutilizáveis: Card, Stat, Table, Button, Badge.

Critério de aceite: a navegação renderiza todas as telas placeholder com o visual do print; trocar
de instância no topo muda o contexto; assets versionados (confirme que mudar o build muda a URL do
JS/CSS).
```

## P2.2 — Live Chat

```
Leia CLAUDE.md §Frontend (atenção ao grid-template-rows).

Implemente o Live Chat:
1. Backend: GET conversas por instância (lista de contatos com última mensagem + não-lidas),
   GET mensagens por contato (paginado), POST responder (chama /instances/:id/messages).
2. Frontend: layout de 3 áreas — lista de conversas | thread de mensagens | composer.
3. REGRA CRÍTICA DE LAYOUT: o container da conversa usa CSS Grid com grid-template-rows EXPLÍCITO
   (ex.: header auto / mensagens 1fr com overflow-y:auto / composer auto). Sem isso, muitas
   mensagens empurram o composer pra fora da tela. Comente essa linha explicando o porquê.
4. Marcar como lida ao abrir a conversa. Atualização (polling curto ou SSE — escolha o mais simples
   pro serverless; evite WebSocket persistente na camada web).

Critério de aceite: abrir uma conversa com 200+ mensagens mantém o composer fixo e visível; enviar
resposta funciona; contador de não-lidas atualiza.
```

## P2.3 — Dashboard

```
Leia CLAUDE.md. Implemente o Dashboard do print.

1. Backend: endpoint de métricas por instância — enviadas, recebidas, contatos, instâncias ativas,
   taxa de entrega, taxa de leitura, série de volume dos últimos 30 dias (enviadas vs recebidas),
   distribuição por tipo de mensagem, e volume por instância.
2. Frontend: linha de cards (6 stats), gráfico de área "Volume — Últimos 30 dias", donut "Tipos de
   Mensagem", tabela "Volume por Instância". Use uma lib de gráfico leve.

Critério de aceite: o dashboard reflete dados reais do banco; performático mesmo com muitas
mensagens (queries agregadas, não N+1).
```

---

# FASE 3 — Listas + Campanhas + Disparo em massa

## P3.1 — Listas e Campanhas (modelagem + telas)

```
Leia CLAUDE.md. Implemente Listas de contato e o cadastro de Campanhas.

1. Listas: CRUD, adicionar/remover contatos, listar contatos da lista. Escopo por instância.
2. Campanha: criar com template + lista(s) + mapeamento de variáveis por contato (ex.: {{nome}}),
   intervalo entre envios (interval_ms configurável), e o cálculo de total_recipients.
3. Telas: criar campanha (escolher template sincronizado, escolher listas, configurar intervalo,
   pré-visualizar destinatários e variáveis) e acompanhar status.
4. NÃO dispare ainda — só modelagem, criação e a UI. O disparo é o P3.2.

Critério de aceite: consigo montar uma campanha completa e ver a lista de destinatários resolvida
com variáveis, sem enviar nada.
```

## P3.2 — Motor de disparo em massa (o módulo sensível)

```
Leia CLAUDE.md §Disparo em massa E 01_PLANO_E_ARQUITETURA.md §7. Este é o módulo mais sensível.
Siga as regras à risca.

Implemente o motor de disparo:
1. Processamento RETOMÁVEL em lotes. A campanha tem estado no banco (cursor de progresso,
   sent_count, failed_count, status). Cada "tick" processa UM lote e reagenda o próximo. NUNCA
   processe a campanha inteira numa request só (timeout serverless).
2. Para cada destinatário do lote:
   - envia via provider.sendTemplate(...) com o idioma correto do template;
   - grava o resultado em campaign_sends SEMPRE (sucesso E falha), com error_code/error_message.
   Proibido "só grava se deu certo".
3. Use Promise.allSettled no lote — nunca Promise.all. Uma falha não pode apagar o rastro dos outros.
4. Intervalo configurável (interval_ms) respeitado entre envios. Sem paralelismo agressivo por
   padrão; se implementar paralelismo, deixe-o desligado por default e documentável.
5. Retry SÓ em rate-limit (códigos como 130429/131056), com espera antes de retentar. SEM retry em
   erro permanente (número inválido etc.).
6. Acompanhamento em tempo (quase) real na UI: enviados/entregues/lidos/falhados, com lista de
   falhas e seus motivos (auditável).
7. Como agendar os "ticks" sem cron: aproveite o mesmo mecanismo de retomada dos fluxos (tráfego de
   webhook dispara o avanço) e/ou um endpoint /campaigns/:id/tick idempotente que a UI chama em
   polling enquanto a campanha está ativa. Documente a escolha.

Critério de aceite (é o critério de sucesso do PRD): uma campanha simulada de 1000+ contatos com
falhas injetadas termina SEM nenhuma execução perdida em silêncio — toda falha aparece em
campaign_sends com motivo. Escreva um teste que injeta falhas e verifica que 100% dos resultados
foram logados.
```

---

# FASE 4 — Motor de fluxos + builder (o coração)

## P4.1 — Máquina de estados + engine puro

```
Leia CLAUDE.md §Motor de fluxos E 01_PLANO_E_ARQUITETURA.md §8. Estas 5 lições são o teste de fogo
do projeto.

Implemente o núcleo do motor de fluxos como MÓDULO PURO em /domain (chamável tanto pela camada web
quanto, no futuro, pelo worker Baileys — nada de dependência de HTTP aqui):

1. Modelo flow_executions: status (running|waiting_input|completed|cancelled), current_node_id,
   variables (json), next_step_at.
2. Função runExecution(execution, event) que avança a máquina de estados nó a nó, retornando as
   AÇÕES a executar (ex.: enviar mensagem via provider) e o novo estado a persistir. Determinística
   e testável sem rede.
3. processPendingExecutions(instanceId): varre execuções com next_step_at vencido e as retoma.
   Idempotente e seguro sob concorrência (uma execução não pode ser retomada em duplicidade — use
   trava otimista/condicional no update de status).
4. Resolução de variáveis {{nome}} em textos, a partir de execution.variables + dados do contato.

NÃO implemente ainda todos os tipos de nó — só Início, Mensagem e Fim, para validar o loop.

Critério de aceite: um fluxo Início→Mensagem→Fim executa e completa; teste unitário do engine sem
tocar em rede; teste de que processPendingExecutions não retoma a mesma execução duas vezes sob
concorrência.
```

## P4.2 — Nós de conteúdo e ramificação simples

```
Leia CLAUDE.md. Adicione ao engine os nós: Mídia, Botões, Lista, Tag.

1. Mídia: envia imagem/vídeo/áudio/documento via provider.sendMedia.
2. Botões: até 3 botões de resposta rápida — CADA botão é uma saída (edge) própria do fluxo.
3. Lista: lista interativa até 10 opções — CADA opção é uma saída própria.
4. Tag: aplica uma tag ao contato (via repo).
Roteamento: quando o contato responde a um botão/opção, o webhook (P1.2) precisa casar a resposta
com a execução em waiting_input e seguir pela aresta correspondente.

Critério de aceite: um fluxo com Botões roteia corretamente conforme o botão clicado; aplicar Tag
reflete no contato. Testes de roteamento por botão/opção.
```

## P4.3 — Nó Aguardar (delay) — a lição nº 1 e nº 2

```
Leia CLAUDE.md §Motor de fluxos, lições 1 e 2. NÃO implemente sleep longo dentro do processo.

Implemente o nó Aguardar (delay) com DELAY HÍBRIDO POR DURAÇÃO:
1. Delay curto (< LIMIAR, ex.: 10s): dormir inline é aceitável (risco de concorrência desprezível),
   para não fazer o bot parecer "preso" esperando o lead.
2. Delay longo (>= LIMIAR): resolver a próxima aresta JÁ, gravar current_node_id apontando pro
   próximo nó, next_step_at = agora + segundos, e RETORNAR SEM ESPERAR. A retomada acontece via
   processPendingExecutions (disparado pelo tráfego de webhook, em background por instância).
3. O LIMIAR é uma constante configurável e documentada.

Critério de aceite (critério de sucesso do PRD): um fluxo com vários delays curtos flui sozinho sem
o lead precisar mandar mensagem; um delay longo sobrevive ao "fim" da request e é retomado depois.
Escreva um teste que simula a reciclagem do processo durante um delay longo e verifica que a
execução é retomada (não fica presa).
```

## P4.4 — Randomizador (atômico), Condição, Aguardar Resposta, Webhook

```
Leia CLAUDE.md, lições 3, 4 e 5.

1. Randomizador: distribui a execução entre N caminhos. Modo aleatório e modo round-robin. O
   round-robin USA repo.flowNodeCounters.incrementAndGet (instrução SQL atômica única) — NUNCA
   ler→somar→salvar. Reaproveite o teste de concorrência do contador.
2. Condição: avalia regras em ordem (texto contém, variável contém, tem tag), múltiplas saídas +
   "senão".
3. Aguardar Resposta: coloca a execução em waiting_input, salva a resposta numa variável quando o
   contato responder. Opcional: tempo limite com uma segunda saída "sem resposta" (para remarketing).
   O timeout usa o MESMO mecanismo de next_step_at.
4. Webhook (nó): chama URL externa (GET/POST), pode salvar a resposta numa variável.
5. LIÇÃO 4 (editar ao vivo): quando uma retomada/resposta não encontrar o current_node_id no fluxo
   atual (nó apagado/recriado), LOGUE E AVISE — não cancele em silêncio.
6. LIÇÃO 5 (trava): ao iniciar um fluxo por palavra-chave, trave por (fluxo + contato), NÃO por
   contato+instância inteira. Implemente limpeza de execuções presas (timeout configurável).

Critério de aceite: round-robin distribui igualmente sob concorrência (teste); Condição roteia certo;
Aguardar Resposta com timeout roteia pra "sem resposta"; retomada em nó inexistente gera log/aviso,
não cancelamento silencioso; iniciar um fluxo novo não é bloqueado por execução presa em outro fluxo.
```

## P4.5 — Builder visual de fluxos

```
Leia CLAUDE.md. Construa o builder visual (frontend) para montar fluxos por nós e arestas.

1. Canvas com nós arrastáveis e arestas (setas) conectando saídas → entradas. Cada tipo de nó do
   engine com seu editor de conteúdo. Use uma lib de node-editor leve.
2. trigger_keywords do fluxo (palavras que disparam o fluxo na mensagem recebida) e flag active.
3. Persistência: salva nodes[json]/edges[json] em flows via API.
4. PROTEÇÃO DA LIÇÃO 4: ao editar, PREFIRA editar o conteúdo do nó a apagar+recriar (que muda o ID).
   Se o usuário for apagar um nó, avise sobre execuções ativas que possam estar paradas nele.
   Mostre um aviso claro no editor sobre o risco de editar fluxo com execuções ativas.
5. Validação: fluxo sem Início, arestas soltas, nós órfãos — avisar antes de salvar/ativar.

Critério de aceite: monto visualmente um fluxo Início→Mensagem→Botões→(delay longo)→Mensagem→Fim,
salvo, disparo por palavra-chave e ele executa ponta a ponta respeitando os delays.
```

---

# FASE 5 — V2 (multi-tenancy, Baileys, mobile)

> Só comece a V2 quando a V1 estiver estável e os critérios de sucesso do PRD forem atingidos.

## P5.1 — Multi-tenancy (orgs, usuários, auth)

```
Leia CLAUDE.md §Multi-tenancy e 01_PLANO_E_ARQUITETURA.md. Vamos transformar o app em SaaS
multi-tenant SEM quebrar a V1.

1. Migrations [V2]: orgs (id, name, plan), users (id, org_id, email, role[owner|agent],
   password_hash). Adicione org_id em instances (e propague o escopo).
2. Auth: login/registro (Supabase Auth ou JWT próprio). Toda rota autenticada resolve o org_id do
   usuário.
3. Escopo: TODA query passa a filtrar por org_id além de instance_id. Um usuário só enxerga
   instâncias/dados da sua org. Escreva testes de isolamento (org A não acessa dados da org B).
4. Papéis: owner (gerencia instâncias, billing, usuários) vs agent (só atende no Live Chat). Aplique
   nas rotas.
5. Migração de dados existentes: crie uma org default e associe as instâncias atuais a ela, sem
   perder nada.

Critério de aceite: dois tenants coexistem totalmente isolados; teste de isolamento cross-org passa;
a V1 (uso próprio) continua funcionando dentro da org default.
```

## P5.2 — Provider Baileys + worker persistente

```
Leia 01_PLANO_E_ARQUITETURA.md §2 (arquitetura híbrida) e §4.2, e CLAUDE.md.

Contexto crítico: Baileys precisa de conexão WebSocket VIVA e permanente por número. Isso NÃO roda
na camada web serverless. Implemente como um serviço worker separado sempre-ligado que compartilha
o MESMO Postgres.

1. BaileysProvider: implementação real da interface Provider usando @whiskeysockets/baileys
   (sendText, sendMedia, sendButtons, sendList, sendReaction; provider.capabilities marcando o que o
   Baileys NÃO suporta — ex.: templates/HSM). O resto do sistema continua chamando só provider.*.
2. Worker (/worker): processo Node sempre-ligado que:
   - mantém 1 socket por instância provider_type='baileys' conectada;
   - persiste a sessão/credenciais (auth state) de forma segura e restaurável após restart do worker
     (não em memória volátil);
   - expõe o fluxo de conexão via QR code (a UI mostra o QR; o worker gera/atualiza; connection_status
     na instância reflete pending/connected/disconnected);
   - ao receber mensagem via socket, grava no MESMO banco e chama o MESMO motor de fluxos do /domain
     (reuso total — nada duplicado);
   - consome a tabela outbox para envios iniciados pela camada web (campanhas/disparos): a web insere
     a intenção em outbox, o worker envia e atualiza status. Envios reativos (resposta dentro do
     worker) podem chamar o provider direto.
3. Deploy do worker: Railway/Fly/VPS pequeno apontando pro mesmo Supabase. Documente o setup.
4. Reconexão robusta: reconectar sozinho em queda, backoff, e refletir connection_status.

Regras que continuam valendo no Baileys: logue todo envio; allSettled em lotes; intervalo
configurável (reputação de número importa AINDA MAIS no não-oficial); motor de fluxos idêntico.

Critério de aceite: conecto um número via QR, recebo/respondo mensagens que passam pelo mesmo Live
Chat e pelos mesmos fluxos da V1; uma campanha via outbox é enviada pelo worker e logada em
campaign_sends; o worker reconecta sozinho após queda; sessão sobrevive a restart do worker.
```

## P5.3 — App mobile simplificado (APK)

```
Leia 01_PLANO_E_ARQUITETURA.md. Crie um app mobile ENXUTO (Expo/React Native, gera APK) para
atendentes que só querem ler e responder conversas — não é o painel completo.

1. Escopo: login (auth da V2), seleção de instância, lista de conversas, thread de mensagens,
   responder (texto + mídia básica). Nada de campanhas, fluxos ou CRM avançado.
2. Consome a MESMA REST API da V2 (nada de lógica de negócio nova no app — é um cliente fino).
3. Respeita papéis: um usuário 'agent' vê só o Live Chat da sua org.
4. Notificações push de mensagem nova (Expo Notifications) — opcional, mas deixe o gancho.
5. Build de APK documentado (eas build ou equivalente).

Critério de aceite: instalo o APK, logo como atendente, vejo as conversas da minha org e respondo;
a resposta aparece no Live Chat web em tempo (quase) real.
```

---

# Apêndice — hábitos que evitam retrabalho

- **Sempre reforce o `CLAUDE.md`** no início de sessões longas.
- **Um prompt = um PR pequeno.** Se o agente quiser fazer 5 coisas, peça pra fatiar.
- **Teste os pontos de concorrência de verdade** (contador atômico, retomada de delay, dedupe de
  webhook). São exatamente os bugs que "só aparecem em produção".
- **Nunca aceite "só grava se deu certo"** em nenhum lugar que envolva envio.
- **Ao mexer em fluxo/campanha/delay,** peça ao agente pra dizer explicitamente qual regra do
  `CLAUDE.md` respeitou.
- **Peça migração sem perda** sempre que a V2 mudar schema (org_id, etc.).
