-- P6.1 / L3 — instances.org_id passa a ser NOT NULL com FK para orgs.
-- Espelho de sqlite/012_instances_org_not_null.sql.
--
-- POR QUÊ: o default 'org_default' morava no ADAPTER, não no banco. Qualquer
-- escrita que não passasse por repo.* (script, psql na mão, migration futura)
-- criava instância SEM DONO — invisível para todo usuário, mas ainda varrida
-- por cron, webhook e worker. Instância órfã é a forma mais silenciosa de
-- perder dado neste sistema.
--
-- ON DELETE RESTRICT (e não CASCADE) de propósito: apagar uma org que ainda
-- tem instância deve DOER, não sumir com conversas reais em cascata.
--
-- AUDITE ANTES DE RODAR (ver DEPLOY.md):
--   SELECT id, name, org_id FROM instances WHERE org_id IS NULL;
--   SELECT i.id FROM instances i LEFT JOIN orgs o ON o.id = i.org_id
--    WHERE o.id IS NULL;
-- A primeira consulta é corrigida pelo UPDATE abaixo; a segunda faz a criação
-- da FK falhar ALTO, de propósito.

UPDATE instances SET org_id = 'org_default' WHERE org_id IS NULL;

ALTER TABLE instances ALTER COLUMN org_id SET NOT NULL;

-- Bloco tolerante só à re-execução parcial (a constraint já existir); qualquer
-- outro erro — inclusive órfã apontando para org inexistente — propaga.
DO $$
BEGIN
  ALTER TABLE instances
    ADD CONSTRAINT fk_instances_org
    FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE RESTRICT;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE INDEX IF NOT EXISTS ix_instances_org ON instances (org_id);
