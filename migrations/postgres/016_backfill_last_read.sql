-- Backfill de last_read_at (Live Chat / Fase 3). Espelho de sqlite/016.
--
-- POR QUÊ: a 003_contacts_last_read.sql adicionou a coluna SEM backfill. Todo
-- contato cuja conversa nunca foi aberta neste painel ficou com
-- last_read_at IS NULL, e o cálculo de não-lidas
-- (SUM inbound WHERE created_at > COALESCE(last_read_at,'')) conta TODO o
-- histórico inbound desde sempre como "não lida" — não é erro de conta, é
-- ausência de estado inicial. Decisão registrada na auditoria de
-- 2026-08-19: opção 1 (backfill único) agora, opção 3 (sincronizar
-- unreadCount do Baileys) fica em backlog — ver conversa/relatório daquela
-- rodada.
--
-- POR QUÊ TIMESTAMP FIXO, não now(): é o que torna isto REVERSÍVEL. now()
-- gravaria um valor diferente por linha (ou por execução), e não haveria
-- como distinguir depois "quem foi tocado por este backfill" de "quem já
-- tinha last_read_at". Com valor fixo, o revert é exato:
--   UPDATE contacts SET last_read_at = NULL
--     WHERE last_read_at = '2026-08-19T00:00:00.000Z';
--
-- NOTA CLAUDE.md: isto é um UPDATE de dado, não "adição nullable" (a regra
-- geral de migration deste projeto). Documentado aqui por instrução explícita
-- do Rafael, com o SQL e a estratégia de revert definidos por ele — não é
-- uma decisão autônoma de correção especulativa.
--
-- ESTE ARQUIVO SÓ FOI PREPARADO, NÃO EXECUTADO — roda com `npm run migrate`,
-- que é ação do Rafael, não desta sessão.
UPDATE contacts
SET last_read_at = '2026-08-19T00:00:00.000Z'
WHERE last_read_at IS NULL;
