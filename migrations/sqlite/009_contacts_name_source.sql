-- P1.5: plano B do nome do contato. Espelho de postgres/009_contacts_name_source.sql.
--
-- NULL / 'profile' → nome veio do profile.name da Meta (ou é desconhecido)
-- 'manual'         → o operador digitou; webhook não sobrescreve mais.
ALTER TABLE contacts ADD COLUMN name_source TEXT;
