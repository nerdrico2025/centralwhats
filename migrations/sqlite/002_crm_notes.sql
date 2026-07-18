-- Adiciona coluna de notas ao CRM (P1.5). Espelho de postgres/002_crm_notes.sql.
ALTER TABLE crm_contacts ADD COLUMN notes TEXT;
