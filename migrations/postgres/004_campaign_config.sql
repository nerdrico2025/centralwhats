-- Config da campanha (P3.1): listas selecionadas + mapeamento de variáveis.
-- Espelho de sqlite/004_campaign_config.sql.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS config TEXT;
