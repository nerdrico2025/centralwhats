-- Avatar do contato no Live Chat. Espelho de postgres/015_contacts_avatar.sql.
--
-- POR QUE PERSISTIR e não buscar sob demanda: a foto vem do socket do Baileys,
-- que só existe no worker (Railway). A camada web é serverless e não importa
-- nada de src/worker/ — qualquer desenho em que o painel peça "busca o avatar
-- agora" seria impossível, não apenas lento.
--
-- POR QUE DUAS COLUNAS: `avatar_fetched_at` é o que permite CACHE NEGATIVO.
-- Contato que esconde a foto por privacidade fica com url nula E carimbo
-- preenchido — sem o carimbo, todo contato sem foto viraria uma chamada de
-- rede por mensagem recebida, para sempre.
--
-- Ambas NULLABLE: contato existente não tem avatar e instância Meta nunca vai
-- ter (a Cloud API não expõe foto de contato arbitrário — ali o painel usa
-- placeholder de iniciais).
-- SQLite não tem IF NOT EXISTS em ADD COLUMN; o migrador roda cada arquivo
-- uma vez só (tabela _migrations), então não há repetição.
ALTER TABLE contacts ADD COLUMN avatar_url TEXT;
ALTER TABLE contacts ADD COLUMN avatar_fetched_at TEXT;
