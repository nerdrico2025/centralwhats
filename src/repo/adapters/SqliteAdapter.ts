import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { normalizePhone } from '../../util/phone';
import { listMigrations } from '../../util/paths';
import { buildVolumeSeries } from '../../util/metrics';
import { isEncrypted, openSecret, sealSecret } from '../../util/crypto';
import type { Repo } from '../Repo';
import type { Campaign, Flow, FlowExecution, Instance, Tag, UserRole } from '../types';
import * as m from './mappers';

// node:sqlite é um builtin novo, ainda ausente de module.builtinModules; por
// isso bundlers (Vite/vitest) tentam resolvê-lo como pacote. Carregar via
// createRequire mantém a resolução no runtime do Node.
const nodeRequire = createRequire(__filename);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/**
 * Adapter SQLite (dev), via node:sqlite (built-in, sem build nativo).
 * ÚNICO lugar (junto do PostgresAdapter) onde SQL cru pode existir.
 * Toda operação de tenant filtra por instance_id.
 */
export function createSqliteAdapter(opts: { path: string }): Repo {
  const db = new DatabaseSync(opts.path);
  db.exec('PRAGMA foreign_keys = ON;');

  const now = (): string => new Date().toISOString();
  const uid = (): string => randomUUID();

  const get = (sql: string, ...p: unknown[]): Record<string, unknown> | undefined =>
    db.prepare(sql).get(...(p as never[])) as Record<string, unknown> | undefined;
  const all = (sql: string, ...p: unknown[]): Record<string, unknown>[] =>
    db.prepare(sql).all(...(p as never[])) as Record<string, unknown>[];
  const run = (sql: string, ...p: unknown[]): { changes: number | bigint } =>
    db.prepare(sql).run(...(p as never[]));

  /** IN (?,?,...) para uma lista de valores. */
  const inClause = (values: string[]): { ph: string } => ({
    ph: values.map(() => '?').join(','),
  });

  const repo: Repo = {
    driver: 'sqlite',
    target: opts.path === ':memory:' ? ':memory:' : resolvePath(opts.path),
    // ---------------------------------------------------------------- instances
    instances: {
      async create(data) {
        // SEM default de org_id: instância sem dono é invisível para todo
        // usuário e ainda assim varrida por cron/webhook/worker (L3). Quem
        // cria sempre tem a org ativa à mão — passar é obrigatório.
        if (!data.org_id) {
          throw new Error('instances.create: org_id é obrigatório (instância sem dono é proibida)');
        }
        const id = uid();
        run(
          `INSERT INTO instances
             (id,org_id,name,provider_type,phone_number_id,waba_id,token,verify_token,active,connection_status,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          id,
          data.org_id,
          data.name,
          data.provider_type ?? 'meta',
          data.phone_number_id,
          data.waba_id,
          sealSecret(data.token),
          sealSecret(data.verify_token),
          m.fromBool(data.active ?? true),
          data.connection_status ?? 'disconnected',
          now(),
        );
        return (await this.getById(id)) as Instance;
      },
      async getById(id) {
        const r = get(`SELECT * FROM instances WHERE id=?`, id);
        return r ? m.mapInstance(r) : null;
      },
      async list(orgId) {
        return all(
          `SELECT * FROM instances WHERE org_id=? ORDER BY created_at ASC`,
          orgId,
        ).map(m.mapInstance);
      },
      async listAll() {
        return all(`SELECT * FROM instances ORDER BY created_at ASC`).map(m.mapInstance);
      },
      async update(id, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          cols.push(`${c}=?`);
          vals.push(v);
        };
        if (patch.name !== undefined) set('name', patch.name);
        if (patch.org_id !== undefined) set('org_id', patch.org_id);
        if (patch.provider_type !== undefined) set('provider_type', patch.provider_type);
        if (patch.phone_number_id !== undefined) set('phone_number_id', patch.phone_number_id);
        if (patch.waba_id !== undefined) set('waba_id', patch.waba_id);
        if (patch.token !== undefined) set('token', sealSecret(patch.token));
        if (patch.verify_token !== undefined) set('verify_token', sealSecret(patch.verify_token));
        if (patch.active !== undefined) set('active', m.fromBool(patch.active));
        if (patch.connection_status !== undefined)
          set('connection_status', patch.connection_status);
        if (cols.length) {
          vals.push(id);
          run(`UPDATE instances SET ${cols.join(',')} WHERE id=?`, ...vals);
        }
        return this.getById(id);
      },
      async delete(id) {
        run(`DELETE FROM instances WHERE id=?`, id);
      },
      async getByPhoneNumberId(phoneNumberId) {
        const r = get(`SELECT * FROM instances WHERE phone_number_id=?`, phoneNumberId);
        return r ? m.mapInstance(r) : null;
      },
    },

    // ----------------------------------------------------------------- messages
    messages: {
      async create(data) {
        const id = uid();
        run(
          `INSERT INTO messages
             (id,instance_id,direction,from_number,to_number,type,content,status,error_code,error_message,wa_message_id,campaign_id,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id,
          data.instance_id,
          data.direction,
          normalizePhone(data.from_number),
          normalizePhone(data.to_number),
          data.type,
          m.stringifyJson(data.content),
          data.status ?? 'queued',
          data.error_code,
          data.error_message,
          data.wa_message_id,
          data.campaign_id,
          data.created_at ?? now(),
        );
        return m.mapMessage(get(`SELECT * FROM messages WHERE id=?`, id)!);
      },
      async getByWaMessageId(instanceId, waMessageId) {
        const r = get(
          `SELECT * FROM messages WHERE instance_id=? AND wa_message_id=?`,
          instanceId,
          waMessageId,
        );
        return r ? m.mapMessage(r) : null;
      },
      async updateStatusByWaMessageId(instanceId, waMessageId, patch) {
        run(
          `UPDATE messages SET status=?, error_code=?, error_message=?
             WHERE instance_id=? AND wa_message_id=?`,
          patch.status,
          patch.error_code,
          patch.error_message,
          instanceId,
          waMessageId,
        );
      },
      async updateById(id, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          cols.push(`${c}=?`);
          vals.push(v);
        };
        if (patch.status !== undefined) set('status', patch.status);
        if (patch.error_code !== undefined) set('error_code', patch.error_code);
        if (patch.error_message !== undefined) set('error_message', patch.error_message);
        if (patch.wa_message_id !== undefined) set('wa_message_id', patch.wa_message_id);
        if (!cols.length) return;
        vals.push(id);
        run(`UPDATE messages SET ${cols.join(',')} WHERE id=?`, ...vals);
      },
      async listByContact(instanceId, phone, o) {
        const p = normalizePhone(phone);
        const limit = o?.limit ?? 50;
        const before = o?.before;
        const rows = before
          ? all(
              `SELECT * FROM messages
                 WHERE instance_id=? AND (from_number=? OR to_number=?) AND created_at < ?
                 ORDER BY created_at DESC LIMIT ?`,
              instanceId,
              p,
              p,
              before,
              limit,
            )
          : all(
              `SELECT * FROM messages
                 WHERE instance_id=? AND (from_number=? OR to_number=?)
                 ORDER BY created_at DESC LIMIT ?`,
              instanceId,
              p,
              p,
              limit,
            );
        return rows.map(m.mapMessage);
      },
      async listConversations(instanceId) {
        // Conversa = contato (o número não-empresarial). conv_phone é o from em
        // inbound e o to em outbound. Window functions: última msg (rn=1) +
        // não-lidas (SUM sobre a partição). Uma query só, sem N+1.
        const rows = all(
          `SELECT phone, name, last_type, last_content, last_direction, last_at, unread
             FROM (
               SELECT
                 msg.conv_phone AS phone,
                 c.name AS name,
                 msg.type AS last_type,
                 msg.content AS last_content,
                 msg.direction AS last_direction,
                 msg.created_at AS last_at,
                 ROW_NUMBER() OVER (PARTITION BY msg.conv_phone ORDER BY msg.created_at DESC) AS rn,
                 SUM(CASE WHEN msg.direction='in'
                          AND msg.created_at > COALESCE(c.last_read_at,'') THEN 1 ELSE 0 END)
                     OVER (PARTITION BY msg.conv_phone) AS unread
               FROM (
                 SELECT *, CASE direction WHEN 'in' THEN from_number ELSE to_number END AS conv_phone
                 FROM messages WHERE instance_id=?
               ) msg
               LEFT JOIN contacts c ON c.instance_id=? AND c.phone=msg.conv_phone
             ) t
             WHERE rn=1
             ORDER BY last_at DESC`,
          instanceId,
          instanceId,
        );
        return rows.map(m.mapConversation);
      },
    },

    // ----------------------------------------------------------------- contacts
    contacts: {
      async upsert(data) {
        const phone = normalizePhone(data.phone);
        const id = uid();
        // Nome escrito à mão pelo operador NÃO é sobrescrito por profile.name
        // da Meta (plano B do PRD) — só outra edição manual o substitui.
        // Sem esta trava, o próximo webhook apagaria a correção em silêncio.
        const r = get(
          `INSERT INTO contacts (id,instance_id,phone,name,name_source,last_seen)
             VALUES (?,?,?,?,?,?)
           ON CONFLICT(instance_id,phone) DO UPDATE SET
             name = CASE
               WHEN contacts.name_source = 'manual' AND excluded.name_source IS NOT 'manual'
                 THEN contacts.name
               ELSE COALESCE(excluded.name, contacts.name)
             END,
             name_source = CASE
               WHEN contacts.name_source = 'manual' AND excluded.name_source IS NOT 'manual'
                 THEN contacts.name_source
               WHEN excluded.name IS NULL THEN contacts.name_source
               ELSE excluded.name_source
             END,
             last_seen = COALESCE(excluded.last_seen, contacts.last_seen)
           RETURNING *`,
          id,
          data.instance_id,
          phone,
          data.name,
          data.name_source ?? null,
          data.last_seen,
        );
        return m.mapContact(r!);
      },
      async setName(instanceId, contactId, name, source) {
        const r = get(
          `UPDATE contacts SET name=?, name_source=?
            WHERE instance_id=? AND id=? RETURNING *`,
          name,
          name === null ? null : source,
          instanceId,
          contactId,
        );
        return r ? m.mapContact(r) : null;
      },
      async getById(instanceId, id) {
        const r = get(`SELECT * FROM contacts WHERE instance_id=? AND id=?`, instanceId, id);
        return r ? m.mapContact(r) : null;
      },
      async getByPhone(instanceId, phone) {
        const r = get(
          `SELECT * FROM contacts WHERE instance_id=? AND phone=?`,
          instanceId,
          normalizePhone(phone),
        );
        return r ? m.mapContact(r) : null;
      },
      async list(instanceId, o) {
        if (o?.search) {
          const like = `%${o.search}%`;
          return all(
            `SELECT * FROM contacts WHERE instance_id=? AND (name LIKE ? OR phone LIKE ?)
               ORDER BY name ASC`,
            instanceId,
            like,
            like,
          ).map(m.mapContact);
        }
        return all(
          `SELECT * FROM contacts WHERE instance_id=? ORDER BY name ASC`,
          instanceId,
        ).map(m.mapContact);
      },
      async touchLastSeen(instanceId, phone, at) {
        run(
          `UPDATE contacts SET last_seen=? WHERE instance_id=? AND phone=?`,
          at,
          instanceId,
          normalizePhone(phone),
        );
      },
      async markRead(instanceId, phone, at) {
        run(
          `UPDATE contacts SET last_read_at=? WHERE instance_id=? AND phone=?`,
          at,
          instanceId,
          normalizePhone(phone),
        );
      },
    },

    // ---------------------------------------------------------------- templates
    templates: {
      async upsert(data) {
        const id = uid();
        const r = get(
          `INSERT INTO templates (id,instance_id,name,category,language,status,components,wa_template_id)
             VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(instance_id,name,language) DO UPDATE SET
             category=excluded.category, status=excluded.status,
             components=excluded.components, wa_template_id=excluded.wa_template_id
           RETURNING *`,
          id,
          data.instance_id,
          data.name,
          data.category,
          data.language,
          data.status,
          m.stringifyJson(data.components),
          data.wa_template_id,
        );
        return m.mapTemplate(r!);
      },
      async list(instanceId) {
        return all(
          `SELECT * FROM templates WHERE instance_id=? ORDER BY name ASC`,
          instanceId,
        ).map(m.mapTemplate);
      },
      async getById(instanceId, id) {
        const r = get(`SELECT * FROM templates WHERE instance_id=? AND id=?`, instanceId, id);
        return r ? m.mapTemplate(r) : null;
      },
      async getByName(instanceId, name, language) {
        const r = language
          ? get(
              `SELECT * FROM templates WHERE instance_id=? AND name=? AND language=?`,
              instanceId,
              name,
              language,
            )
          : get(`SELECT * FROM templates WHERE instance_id=? AND name=?`, instanceId, name);
        return r ? m.mapTemplate(r) : null;
      },
    },

    // --------------------------------------------------------------------- tags
    tags: {
      async create(data) {
        const id = uid();
        const r = get(
          `INSERT INTO tags (id,instance_id,name,color) VALUES (?,?,?,?) RETURNING *`,
          id,
          data.instance_id,
          data.name,
          data.color,
        );
        return m.mapTag(r!);
      },
      async list(instanceId) {
        return all(`SELECT * FROM tags WHERE instance_id=? ORDER BY name ASC`, instanceId).map(
          m.mapTag,
        );
      },
      async delete(instanceId, id) {
        run(`DELETE FROM tags WHERE instance_id=? AND id=?`, instanceId, id);
      },
      async applyToContacts(instanceId, tagId, contactIds) {
        if (!contactIds.length) return;
        // Garante que a tag é da instância antes de aplicar (escopo).
        const tag = get(`SELECT id FROM tags WHERE instance_id=? AND id=?`, instanceId, tagId);
        if (!tag) return;
        const { ph } = inClause(contactIds);
        // Só contatos que pertencem à instância.
        const valid = all(
          `SELECT id FROM contacts WHERE instance_id=? AND id IN (${ph})`,
          instanceId,
          ...contactIds,
        ).map((r) => r.id as string);
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO contact_tags (contact_id,tag_id) VALUES (?,?)`,
        );
        for (const cid of valid) stmt.run(cid, tagId);
      },
      async removeFromContacts(instanceId, tagId, contactIds) {
        if (!contactIds.length) return;
        const tag = get(`SELECT id FROM tags WHERE instance_id=? AND id=?`, instanceId, tagId);
        if (!tag) return;
        const { ph } = inClause(contactIds);
        run(
          `DELETE FROM contact_tags WHERE tag_id=? AND contact_id IN (${ph})`,
          tagId,
          ...contactIds,
        );
      },
      async listForContact(instanceId, contactId) {
        return all(
          `SELECT t.* FROM tags t
             JOIN contact_tags ct ON ct.tag_id = t.id
             WHERE t.instance_id=? AND ct.contact_id=?
             ORDER BY t.name ASC`,
          instanceId,
          contactId,
        ).map(m.mapTag);
      },
      async listGroupedByContact(instanceId) {
        // Escopo nos DOIS lados (tag e contato): nada de outra instância entra.
        const rows = all(
          `SELECT ct.contact_id AS _contact_id, t.*
             FROM tags t
             JOIN contact_tags ct ON ct.tag_id = t.id
             JOIN contacts c ON c.id = ct.contact_id
            WHERE t.instance_id=? AND c.instance_id=?
            ORDER BY t.name ASC`,
          instanceId,
          instanceId,
        );
        const out: Record<string, Tag[]> = {};
        for (const r of rows) {
          const cid = String(r._contact_id);
          (out[cid] ??= []).push(m.mapTag(r));
        }
        return out;
      },
    },

    // ---------------------------------------------------------------------- crm
    crm: {
      async upsert(data) {
        const id = uid();
        const phone = normalizePhone(data.phone);
        const r = get(
          `INSERT INTO crm_contacts (id,instance_id,contact_id,phone,name,stage,score,notes,custom_fields)
             VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(instance_id,contact_id) DO UPDATE SET
             phone=excluded.phone, name=excluded.name, stage=excluded.stage,
             score=excluded.score, notes=excluded.notes, custom_fields=excluded.custom_fields
           RETURNING *`,
          id,
          data.instance_id,
          data.contact_id,
          phone,
          data.name,
          data.stage,
          data.score,
          data.notes,
          m.stringifyJson(data.custom_fields ?? {}),
        );
        return m.mapCrm(r!);
      },
      async getByContact(instanceId, contactId) {
        const r = get(
          `SELECT * FROM crm_contacts WHERE instance_id=? AND contact_id=?`,
          instanceId,
          contactId,
        );
        return r ? m.mapCrm(r) : null;
      },
      async list(instanceId, o) {
        const rows = o?.stage
          ? all(
              `SELECT * FROM crm_contacts WHERE instance_id=? AND stage=? ORDER BY name ASC`,
              instanceId,
              o.stage,
            )
          : all(`SELECT * FROM crm_contacts WHERE instance_id=? ORDER BY name ASC`, instanceId);
        return rows.map(m.mapCrm);
      },
    },

    // -------------------------------------------------------------------- lists
    lists: {
      async create(data) {
        const id = uid();
        const r = get(
          `INSERT INTO contact_lists (id,instance_id,name) VALUES (?,?,?) RETURNING *`,
          id,
          data.instance_id,
          data.name,
        );
        return m.mapList(r!);
      },
      async list(instanceId) {
        return all(
          `SELECT * FROM contact_lists WHERE instance_id=? ORDER BY name ASC`,
          instanceId,
        ).map(m.mapList);
      },
      async delete(instanceId, id) {
        run(`DELETE FROM contact_lists WHERE instance_id=? AND id=?`, instanceId, id);
      },
      async addContacts(instanceId, listId, contactIds) {
        if (!contactIds.length) return;
        const list = get(
          `SELECT id FROM contact_lists WHERE instance_id=? AND id=?`,
          instanceId,
          listId,
        );
        if (!list) return;
        const { ph } = inClause(contactIds);
        const valid = all(
          `SELECT id FROM contacts WHERE instance_id=? AND id IN (${ph})`,
          instanceId,
          ...contactIds,
        ).map((r) => r.id as string);
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO list_contacts (list_id,contact_id) VALUES (?,?)`,
        );
        for (const cid of valid) stmt.run(listId, cid);
      },
      async removeContacts(instanceId, listId, contactIds) {
        if (!contactIds.length) return;
        const list = get(
          `SELECT id FROM contact_lists WHERE instance_id=? AND id=?`,
          instanceId,
          listId,
        );
        if (!list) return;
        const { ph } = inClause(contactIds);
        run(
          `DELETE FROM list_contacts WHERE list_id=? AND contact_id IN (${ph})`,
          listId,
          ...contactIds,
        );
      },
      async listContacts(instanceId, listId) {
        return all(
          `SELECT c.* FROM contacts c
             JOIN list_contacts lc ON lc.contact_id = c.id
             JOIN contact_lists cl ON cl.id = lc.list_id
             WHERE cl.instance_id=? AND cl.id=?
             ORDER BY c.name ASC`,
          instanceId,
          listId,
        ).map(m.mapContact);
      },
    },

    // ---------------------------------------------------------------- campaigns
    campaigns: {
      async create(data) {
        const id = uid();
        const r = get(
          `INSERT INTO campaigns
             (id,instance_id,name,template_id,sent_count,failed_count,total_recipients,interval_ms,status,config,created_at)
           VALUES (?,?,?,?,0,0,?,?,?,?,?) RETURNING *`,
          id,
          data.instance_id,
          data.name,
          data.template_id,
          data.total_recipients ?? 0,
          data.interval_ms ?? 1000,
          data.status ?? 'draft',
          m.stringifyJson(data.config ?? { list_ids: [], variables: {} }),
          now(),
        );
        return m.mapCampaign(r!);
      },
      async getById(instanceId, id) {
        const r = get(`SELECT * FROM campaigns WHERE instance_id=? AND id=?`, instanceId, id);
        return r ? m.mapCampaign(r) : null;
      },
      async list(instanceId) {
        return all(
          `SELECT * FROM campaigns WHERE instance_id=? ORDER BY created_at DESC`,
          instanceId,
        ).map(m.mapCampaign);
      },
      async update(instanceId, id, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          cols.push(`${c}=?`);
          vals.push(v);
        };
        if (patch.name !== undefined) set('name', patch.name);
        if (patch.template_id !== undefined) set('template_id', patch.template_id);
        if (patch.sent_count !== undefined) set('sent_count', patch.sent_count);
        if (patch.failed_count !== undefined) set('failed_count', patch.failed_count);
        if (patch.total_recipients !== undefined)
          set('total_recipients', patch.total_recipients);
        if (patch.interval_ms !== undefined) set('interval_ms', patch.interval_ms);
        if (patch.status !== undefined) set('status', patch.status);
        if (patch.config !== undefined) set('config', m.stringifyJson(patch.config));
        if (cols.length) {
          vals.push(instanceId, id);
          run(`UPDATE campaigns SET ${cols.join(',')} WHERE instance_id=? AND id=?`, ...vals);
        }
        return this.getById(instanceId, id) as Promise<Campaign | null>;
      },
      async delete(instanceId, id) {
        // campaign_sends cai junto via ON DELETE CASCADE — o PRAGMA
        // foreign_keys=ON no boot do adapter é o que faz a cascata valer.
        const r = run(`DELETE FROM campaigns WHERE instance_id=? AND id=?`, instanceId, id);
        return Number(r.changes) > 0;
      },
      async recordSend(data) {
        const id = uid();
        const r = get(
          `INSERT INTO campaign_sends (id,campaign_id,contact_id,contact_phone,status,wa_message_id,error_code,error_message,sent_at,claimed_at,vars,attempts)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
          id,
          data.campaign_id,
          data.contact_id,
          normalizePhone(data.contact_phone),
          data.status,
          data.wa_message_id ?? null,
          data.error_code,
          data.error_message,
          data.sent_at,
          data.claimed_at ?? null,
          m.stringifyJson(data.vars ?? {}),
          data.attempts ?? 0,
        );
        return m.mapCampaignSend(r!);
      },
      async listSends(campaignId) {
        return all(
          `SELECT * FROM campaign_sends WHERE campaign_id=? ORDER BY sent_at ASC`,
          campaignId,
        ).map(m.mapCampaignSend);
      },
      async listPendingSends(campaignId, limit) {
        return all(
          `SELECT * FROM campaign_sends WHERE campaign_id=? AND status='pending'
             ORDER BY id ASC LIMIT ?`,
          campaignId,
          limit,
        ).map(m.mapCampaignSend);
      },
      async listSendsByStatus(campaignId, status) {
        return all(
          `SELECT * FROM campaign_sends WHERE campaign_id=? AND status=? ORDER BY id ASC`,
          campaignId,
          status,
        ).map(m.mapCampaignSend);
      },
      async claimPendingSends(campaignId, limit, claimedAt) {
        // UMA instrução: seleciona e marca no mesmo UPDATE. Dois ticks
        // concorrentes nunca levam o mesmo destinatário (sem envio duplicado).
        return all(
          `UPDATE campaign_sends SET status='sending', claimed_at=?
             WHERE id IN (
               SELECT id FROM campaign_sends
                 WHERE campaign_id=? AND status='pending'
                 ORDER BY id ASC LIMIT ?
             )
             RETURNING *`,
          claimedAt,
          campaignId,
          limit,
        ).map(m.mapCampaignSend);
      },
      async reclaimStaleSends(campaignId, olderThan) {
        const rows = all(
          `UPDATE campaign_sends SET status='pending', claimed_at=NULL
             WHERE campaign_id=? AND status='sending' AND claimed_at < ?
             RETURNING id`,
          campaignId,
          olderThan,
        );
        return rows.length;
      },
      async updateSend(id, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          cols.push(`${c}=?`);
          vals.push(v);
        };
        if (patch.status !== undefined) set('status', patch.status);
        if (patch.error_code !== undefined) set('error_code', patch.error_code);
        if (patch.error_message !== undefined) set('error_message', patch.error_message);
        if (patch.sent_at !== undefined) set('sent_at', patch.sent_at);
        if (patch.attempts !== undefined) set('attempts', patch.attempts);
        if (patch.wa_message_id !== undefined) set('wa_message_id', patch.wa_message_id);
        if (patch.claimed_at !== undefined) set('claimed_at', patch.claimed_at);
        if (!cols.length) return;
        vals.push(id);
        run(`UPDATE campaign_sends SET ${cols.join(',')} WHERE id=?`, ...vals);
      },
      async markSendFailedByWaMessageId(instanceId, waMessageId, errorCode, errorMessage) {
        // Escopado pela instância da campanha (multi-tenancy) mesmo o wamid
        // sendo único na Meta. Só afeta linhas ainda tidas como 'sent'.
        const rows = all(
          `UPDATE campaign_sends SET status='failed', error_code=?, error_message=?
             WHERE wa_message_id=? AND status='sent'
               AND campaign_id IN (SELECT id FROM campaigns WHERE instance_id=?)
             RETURNING campaign_id`,
          errorCode,
          errorMessage,
          waMessageId,
          instanceId,
        );
        return rows.length ? String(rows[0].campaign_id) : null;
      },
      async countSendsByStatus(campaignId) {
        const rows = all(
          `SELECT status, COUNT(*) c FROM campaign_sends WHERE campaign_id=? GROUP BY status`,
          campaignId,
        );
        const get2 = (s: string): number => Number(rows.find((r) => r.status === s)?.c ?? 0);
        // 'sending' (em voo) conta como pendente: senão a campanha seria dada
        // como concluída com envios ainda acontecendo.
        return {
          sent: get2('sent'),
          failed: get2('failed'),
          pending: get2('pending') + get2('sending'),
        };
      },
    },

    // -------------------------------------------------------------------- flows
    flows: {
      async create(data) {
        const id = uid();
        const r = get(
          `INSERT INTO flows (id,instance_id,name,trigger_keywords,nodes,edges,active)
             VALUES (?,?,?,?,?,?,?) RETURNING *`,
          id,
          data.instance_id,
          data.name,
          m.stringifyJson(data.trigger_keywords ?? []),
          m.stringifyJson(data.nodes ?? []),
          m.stringifyJson(data.edges ?? []),
          m.fromBool(data.active ?? false),
        );
        return m.mapFlow(r!);
      },
      async getById(instanceId, id) {
        const r = get(`SELECT * FROM flows WHERE instance_id=? AND id=?`, instanceId, id);
        return r ? m.mapFlow(r) : null;
      },
      async list(instanceId) {
        return all(`SELECT * FROM flows WHERE instance_id=? ORDER BY name ASC`, instanceId).map(
          m.mapFlow,
        );
      },
      async update(instanceId, id, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          cols.push(`${c}=?`);
          vals.push(v);
        };
        if (patch.name !== undefined) set('name', patch.name);
        if (patch.trigger_keywords !== undefined)
          set('trigger_keywords', m.stringifyJson(patch.trigger_keywords));
        if (patch.nodes !== undefined) set('nodes', m.stringifyJson(patch.nodes));
        if (patch.edges !== undefined) set('edges', m.stringifyJson(patch.edges));
        if (patch.active !== undefined) set('active', m.fromBool(patch.active));
        if (cols.length) {
          vals.push(instanceId, id);
          run(`UPDATE flows SET ${cols.join(',')} WHERE instance_id=? AND id=?`, ...vals);
        }
        return this.getById(instanceId, id) as Promise<Flow | null>;
      },
      async findByTriggerKeyword(instanceId, keyword) {
        const kw = keyword.trim().toLowerCase();
        const rows = all(
          `SELECT * FROM flows WHERE instance_id=? AND active=1`,
          instanceId,
        ).map(m.mapFlow);
        return rows.filter((f) =>
          f.trigger_keywords.some((k) => k.trim().toLowerCase() === kw),
        );
      },
    },

    // ----------------------------------------------------------- flowExecutions
    flowExecutions: {
      async create(data) {
        const id = uid();
        const r = get(
          `INSERT INTO flow_executions
             (id,flow_id,instance_id,contact_phone,current_node_id,status,variables,next_step_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?) RETURNING *`,
          id,
          data.flow_id,
          data.instance_id,
          normalizePhone(data.contact_phone),
          data.current_node_id,
          data.status ?? 'running',
          m.stringifyJson(data.variables ?? {}),
          data.next_step_at,
          now(),
        );
        return m.mapFlowExecution(r!);
      },
      async getById(id) {
        const r = get(`SELECT * FROM flow_executions WHERE id=?`, id);
        return r ? m.mapFlowExecution(r) : null;
      },
      async listDue(instanceId, nowIso) {
        return all(
          `SELECT * FROM flow_executions
             WHERE instance_id=? AND status IN ('running','waiting_input')
               AND next_step_at IS NOT NULL AND next_step_at <= ?
             ORDER BY next_step_at ASC`,
          instanceId,
          nowIso,
        ).map(m.mapFlowExecution);
      },
      async findActiveByFlowAndContact(flowId, contactPhone) {
        const r = get(
          `SELECT * FROM flow_executions
             WHERE flow_id=? AND contact_phone=? AND status IN ('running','waiting_input')
             ORDER BY updated_at DESC LIMIT 1`,
          flowId,
          normalizePhone(contactPhone),
        );
        return r ? m.mapFlowExecution(r) : null;
      },
      async findWaitingByContact(instanceId, contactPhone) {
        const r = get(
          `SELECT * FROM flow_executions
             WHERE instance_id=? AND contact_phone=? AND status='waiting_input'
             ORDER BY updated_at DESC LIMIT 1`,
          instanceId,
          normalizePhone(contactPhone),
        );
        return r ? m.mapFlowExecution(r) : null;
      },
      async listActiveByFlow(flowId) {
        return all(
          `SELECT * FROM flow_executions
             WHERE flow_id=? AND status IN ('running','waiting_input')
             ORDER BY updated_at DESC`,
          flowId,
        ).map(m.mapFlowExecution);
      },
      async updateIfStatus(id, expectedStatus, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          cols.push(`${c}=?`);
          vals.push(v);
        };
        if (patch.status !== undefined) set('status', patch.status);
        if (patch.current_node_id !== undefined) set('current_node_id', patch.current_node_id);
        if (patch.variables !== undefined) set('variables', m.stringifyJson(patch.variables));
        if (patch.next_step_at !== undefined) set('next_step_at', patch.next_step_at);
        set('updated_at', now());
        vals.push(id, expectedStatus);
        // Trava otimista: só aplica se o status atual bater com o esperado.
        const res = run(
          `UPDATE flow_executions SET ${cols.join(',')} WHERE id=? AND status=?`,
          ...vals,
        );
        if (Number(res.changes) === 0) return null;
        return this.getById(id) as Promise<FlowExecution | null>;
      },
      async claimDue(id, nowIso) {
        // Claim numa única instrução condicional: só o primeiro processo que
        // zera o next_step_at vencido "ganha" a retomada.
        const res = run(
          `UPDATE flow_executions SET next_step_at=NULL, updated_at=?
             WHERE id=? AND next_step_at IS NOT NULL AND next_step_at <= ?
               AND status IN ('running','waiting_input')`,
          now(),
          id,
          nowIso,
        );
        if (Number(res.changes) === 0) return null;
        return this.getById(id) as Promise<FlowExecution | null>;
      },
      async cancelStuck(instanceId, cutoffIso) {
        const res = run(
          `UPDATE flow_executions SET status='cancelled', updated_at=?
             WHERE instance_id=? AND status IN ('running','waiting_input')
               AND updated_at < ?
               AND (next_step_at IS NULL OR next_step_at < ?)`,
          now(),
          instanceId,
          cutoffIso,
          cutoffIso,
        );
        return Number(res.changes);
      },
    },

    // -------------------------------------------------------- flowNodeCounters
    flowNodeCounters: {
      async incrementAndGet(flowId, nodeId, n) {
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`incrementAndGet: n inválido (${n})`);
        }
        // LIÇÃO Nº 3: UMA única instrução SQL atômica. Nunca ler→somar→salvar.
        const r = get(
          `INSERT INTO flow_node_counters (flow_id,node_id,counter) VALUES (?,?,0)
             ON CONFLICT(flow_id,node_id) DO UPDATE SET counter=(counter + 1) % ?
           RETURNING counter`,
          flowId,
          nodeId,
          n,
        );
        return Number((r as { counter: number | bigint }).counter);
      },
    },

    // ------------------------------------------------------------- orgs [V2]
    orgs: {
      async create(data) {
        const id = uid();
        const r = get(
          `INSERT INTO orgs (id,name,plan,created_at) VALUES (?,?,?,?) RETURNING *`,
          id,
          data.name,
          data.plan ?? 'free',
          now(),
        );
        return m.mapOrg(r!);
      },
      async getById(id) {
        const r = get(`SELECT * FROM orgs WHERE id=?`, id);
        return r ? m.mapOrg(r) : null;
      },
      async rename(id, name) {
        run(`UPDATE orgs SET name=? WHERE id=?`, name, id);
        return this.getById(id);
      },
      async countInstances(id) {
        return Number(get(`SELECT COUNT(*) c FROM instances WHERE org_id=?`, id)?.c ?? 0);
      },
    },

    // ------------------------------------------------------------ users [V2]
    users: {
      async create(data) {
        const id = uid();
        const r = get(
          `INSERT INTO users (id,org_id,email,name,role,status,password_hash,password_changed_at,last_login_at,created_at)
             VALUES (?,?,?,?,?,?,?,NULL,NULL,?) RETURNING *`,
          id,
          data.org_id,
          data.email.trim().toLowerCase(),
          data.name ?? null,
          data.role ?? 'agent',
          data.status ?? 'active',
          data.password_hash,
          now(),
        );
        return m.mapUser(r!);
      },
      async getByEmail(email) {
        const r = get(`SELECT * FROM users WHERE email=?`, email.trim().toLowerCase());
        return r ? m.mapUser(r) : null;
      },
      async getById(id) {
        const r = get(`SELECT * FROM users WHERE id=?`, id);
        return r ? m.mapUser(r) : null;
      },
      async listByOrg(orgId) {
        return all(`SELECT * FROM users WHERE org_id=? ORDER BY created_at ASC`, orgId).map(
          m.mapUser,
        );
      },
      async countAll() {
        return Number(get(`SELECT COUNT(*) c FROM users`)?.c ?? 0);
      },
      async setPassword(id, passwordHash, changedAt) {
        run(
          `UPDATE users SET password_hash=?, password_changed_at=? WHERE id=?`,
          passwordHash,
          changedAt,
          id,
        );
      },
      async setStatus(id, status) {
        run(`UPDATE users SET status=? WHERE id=?`, status, id);
      },
      async markLogin(id, at, activeOrgId) {
        run(`UPDATE users SET last_login_at=?, org_id=? WHERE id=?`, at, activeOrgId, id);
      },
    },

    // ----------------------------------------------------- org_members [P6.1]
    orgMembers: {
      async add(orgId, userId, role) {
        const r = get(
          `INSERT INTO org_members (org_id,user_id,role,created_at) VALUES (?,?,?,?)
             ON CONFLICT(org_id,user_id) DO UPDATE SET role=excluded.role
           RETURNING *`,
          orgId,
          userId,
          role,
          now(),
        );
        return m.mapOrgMember(r!);
      },
      async getRole(orgId, userId) {
        const r = get(
          `SELECT role FROM org_members WHERE org_id=? AND user_id=?`,
          orgId,
          userId,
        );
        return r ? (r.role as UserRole) : null;
      },
      async listByUser(userId) {
        return all(
          `SELECT mem.org_id, o.name AS org_name, mem.role
             FROM org_members mem JOIN orgs o ON o.id = mem.org_id
            WHERE mem.user_id=? ORDER BY o.name ASC`,
          userId,
        ).map(m.mapMembership);
      },
      async listByOrg(orgId) {
        return all(
          `SELECT u.id AS user_id, u.email, u.name, mem.role, u.status,
                  u.last_login_at, mem.created_at
             FROM org_members mem JOIN users u ON u.id = mem.user_id
            WHERE mem.org_id=? ORDER BY mem.created_at ASC`,
          orgId,
        ).map(m.mapMemberView);
      },
      async remove(orgId, userId) {
        run(`DELETE FROM org_members WHERE org_id=? AND user_id=?`, orgId, userId);
      },
    },

    // --------------------------------------------------------- invites [P6.1]
    invites: {
      async create(data) {
        const r = get(
          `INSERT INTO invites (id,org_id,email,role,token_hash,status,expires_at,created_at,created_by)
             VALUES (?,?,?,?,?,'pending',?,?,?) RETURNING *`,
          uid(),
          data.org_id,
          data.email.trim().toLowerCase(),
          data.role,
          data.token_hash,
          data.expires_at,
          now(),
          data.created_by,
        );
        return m.mapInvite(r!);
      },
      async getByTokenHash(tokenHash) {
        const r = get(`SELECT * FROM invites WHERE token_hash=?`, tokenHash);
        return r ? m.mapInvite(r) : null;
      },
      async getById(orgId, id) {
        const r = get(`SELECT * FROM invites WHERE org_id=? AND id=?`, orgId, id);
        return r ? m.mapInvite(r) : null;
      },
      async listByOrg(orgId) {
        return all(
          `SELECT * FROM invites WHERE org_id=? ORDER BY created_at DESC`,
          orgId,
        ).map(m.mapInvite);
      },
      async markAcceptedIfPending(id, userId, at) {
        // UMA instrução condicional = uso único garantido sob concorrência.
        const res = run(
          `UPDATE invites SET status='accepted', accepted_at=?, accepted_user_id=?
             WHERE id=? AND status='pending'`,
          at,
          userId,
          id,
        );
        return Number(res.changes) > 0;
      },
      async revoke(orgId, id) {
        const res = run(
          `UPDATE invites SET status='revoked' WHERE org_id=? AND id=? AND status='pending'`,
          orgId,
          id,
        );
        return Number(res.changes) > 0;
      },
      async refreshToken(orgId, id, tokenHash, expiresAt) {
        const res = run(
          `UPDATE invites SET token_hash=?, expires_at=?, status='pending'
             WHERE org_id=? AND id=? AND status IN ('pending','revoked')`,
          tokenHash,
          expiresAt,
          orgId,
          id,
        );
        return Number(res.changes) > 0;
      },
    },

    // ----------------------------------------------------- maintenance [P6.1]
    maintenance: {
      async backfillSecretEncryption() {
        const out = {
          instanceTokens: 0,
          instanceVerifyTokens: 0,
          baileysAuthValues: 0,
          skipped: 0,
        };
        // SELECT cru de propósito: aqui é o único ponto que precisa ver a
        // FORMA ARMAZENADA (mapInstance já decifraria e a checagem de
        // idempotência perderia o sentido).
        for (const r of all(`SELECT id, token, verify_token FROM instances`)) {
          if (r.token != null && r.token !== '') {
            if (isEncrypted(r.token)) out.skipped++;
            else {
              run(`UPDATE instances SET token=? WHERE id=?`, sealSecret(String(r.token)), r.id);
              out.instanceTokens++;
            }
          }
          if (r.verify_token != null && r.verify_token !== '') {
            if (isEncrypted(r.verify_token)) out.skipped++;
            else {
              run(
                `UPDATE instances SET verify_token=? WHERE id=?`,
                sealSecret(String(r.verify_token)),
                r.id,
              );
              out.instanceVerifyTokens++;
            }
          }
        }
        for (const r of all(`SELECT instance_id, key, value FROM baileys_auth`)) {
          if (isEncrypted(r.value)) {
            out.skipped++;
            continue;
          }
          run(
            `UPDATE baileys_auth SET value=? WHERE instance_id=? AND key=?`,
            sealSecret(String(r.value)),
            r.instance_id,
            r.key,
          );
          out.baileysAuthValues++;
        }
        return out;
      },
      async findOrphanInstances() {
        return all(
          `SELECT i.id, i.name, i.org_id FROM instances i
             LEFT JOIN orgs o ON o.id = i.org_id
            WHERE i.org_id IS NULL OR o.id IS NULL`,
        ).map((r) => ({
          id: r.id as string,
          name: r.name as string,
          org_id: (r.org_id ?? null) as string | null,
        }));
      },
    },

    // ----------------------------------------------------------- outbox [V2]
    outbox: {
      async enqueue(data) {
        const id = uid();
        const r = get(
          `INSERT INTO outbox (id,instance_id,to_number,payload,status,error,message_id,created_at,sent_at)
             VALUES (?,?,?,?,'pending',NULL,?,?,NULL) RETURNING *`,
          id,
          data.instance_id,
          normalizePhone(data.to_number),
          m.stringifyJson(data.payload),
          data.message_id,
          now(),
        );
        return m.mapOutbox(r!);
      },
      async claimPending(instanceId, limit) {
        // Claim atômico linha a linha (pending→sending): quem perde, pula.
        const candidates = all(
          `SELECT id FROM outbox WHERE instance_id=? AND status='pending'
             ORDER BY created_at ASC LIMIT ?`,
          instanceId,
          limit,
        );
        const claimed: string[] = [];
        for (const c of candidates) {
          const res = run(
            `UPDATE outbox SET status='sending' WHERE id=? AND status='pending'`,
            c.id,
          );
          if (Number(res.changes) > 0) claimed.push(c.id as string);
        }
        if (!claimed.length) return [];
        const { ph } = inClause(claimed);
        return all(`SELECT * FROM outbox WHERE id IN (${ph})`, ...claimed).map(m.mapOutbox);
      },
      async markSent(id) {
        run(`UPDATE outbox SET status='sent', sent_at=?, error=NULL WHERE id=?`, now(), id);
      },
      async setMessageId(id, messageId) {
        run(`UPDATE outbox SET message_id=? WHERE id=?`, messageId, id);
      },
      async markFailed(id, error) {
        run(`UPDATE outbox SET status='failed', sent_at=?, error=? WHERE id=?`, now(), error, id);
      },
      async listByInstance(instanceId, status) {
        const rows = status
          ? all(
              `SELECT * FROM outbox WHERE instance_id=? AND status=? ORDER BY created_at ASC`,
              instanceId,
              status,
            )
          : all(`SELECT * FROM outbox WHERE instance_id=? ORDER BY created_at ASC`, instanceId);
        return rows.map(m.mapOutbox);
      },
    },

    // ------------------------------------------------------ baileysAuth [V2]
    baileysAuth: {
      async get(instanceId, key) {
        const r = get(
          `SELECT value FROM baileys_auth WHERE instance_id=? AND key=?`,
          instanceId,
          key,
        );
        // Decifra ANTES do parse: o que foi cifrado é o JSON serializado.
        return r ? m.parseJson<unknown>(openSecret(r.value), null) : null;
      },
      async set(instanceId, key, value) {
        run(
          `INSERT INTO baileys_auth (instance_id,key,value,updated_at) VALUES (?,?,?,?)
             ON CONFLICT(instance_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
          instanceId,
          key,
          sealSecret(m.stringifyJson(value)),
          now(),
        );
      },
      async delete(instanceId, key) {
        run(`DELETE FROM baileys_auth WHERE instance_id=? AND key=?`, instanceId, key);
      },
      async listKeys(instanceId) {
        return all(`SELECT key FROM baileys_auth WHERE instance_id=?`, instanceId).map(
          (r) => r.key as string,
        );
      },
      async clear(instanceId) {
        run(`DELETE FROM baileys_auth WHERE instance_id=?`, instanceId);
      },
    },

    // ------------------------------------------------------------------ metrics
    metrics: {
      async dashboard(instanceId, orgId) {
        const dir = all(
          `SELECT direction, COUNT(*) c FROM messages WHERE instance_id=? GROUP BY direction`,
          instanceId,
        );
        const sent = Number(dir.find((r) => r.direction === 'out')?.c ?? 0);
        const received = Number(dir.find((r) => r.direction === 'in')?.c ?? 0);

        const contacts = Number(
          get(`SELECT COUNT(*) c FROM contacts WHERE instance_id=?`, instanceId)?.c ?? 0,
        );
        // [V2] agregados cross-instância escopados por org quando informada.
        const activeInstances = orgId
          ? Number(
              get(`SELECT COUNT(*) c FROM instances WHERE active=1 AND org_id=?`, orgId)?.c ?? 0,
            )
          : Number(get(`SELECT COUNT(*) c FROM instances WHERE active=1`)?.c ?? 0);

        const outStatus = all(
          `SELECT status, COUNT(*) c FROM messages
             WHERE instance_id=? AND direction='out' GROUP BY status`,
          instanceId,
        );
        const outTotal = outStatus.reduce((s, r) => s + Number(r.c), 0);
        const deliveredOrBetter = outStatus
          .filter((r) => r.status === 'delivered' || r.status === 'read')
          .reduce((s, r) => s + Number(r.c), 0);
        const readCount = Number(outStatus.find((r) => r.status === 'read')?.c ?? 0);

        // Janela de 30 dias (inclui hoje) por substr do created_at ISO.
        const since = new Date();
        since.setUTCDate(since.getUTCDate() - 29);
        const sinceIso = since.toISOString().slice(0, 10);
        const volRows = all(
          `SELECT substr(created_at,1,10) d, direction, COUNT(*) c FROM messages
             WHERE instance_id=? AND substr(created_at,1,10) >= ? GROUP BY d, direction`,
          instanceId,
          sinceIso,
        ).map((r) => ({ d: String(r.d), direction: String(r.direction), c: Number(r.c) }));

        const byType = all(
          `SELECT type, COUNT(*) c FROM messages WHERE instance_id=? GROUP BY type ORDER BY c DESC`,
          instanceId,
        ).map((r) => ({ type: String(r.type), count: Number(r.c) }));

        const byInstance = (
          orgId
            ? all(
                `SELECT i.id, i.name, COUNT(m.id) c FROM instances i
                   LEFT JOIN messages m ON m.instance_id=i.id
                   WHERE i.org_id=?
                   GROUP BY i.id, i.name ORDER BY c DESC`,
                orgId,
              )
            : all(
                `SELECT i.id, i.name, COUNT(m.id) c FROM instances i
                   LEFT JOIN messages m ON m.instance_id=i.id
                   GROUP BY i.id, i.name ORDER BY c DESC`,
              )
        ).map((r) => ({ instance_id: String(r.id), name: String(r.name), total: Number(r.c) }));

        return {
          sent,
          received,
          contacts,
          active_instances: activeInstances,
          delivery_rate: outTotal ? deliveredOrBetter / outTotal : 0,
          read_rate: outTotal ? readCount / outTotal : 0,
          volume_30d: buildVolumeSeries(volRows, 30),
          by_type: byType,
          by_instance: byInstance,
        };
      },
    },

    // ------------------------------------------------------------------- infra
    async migrate() {
      db.exec(
        `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
      );
      const applied = new Set(
        all(`SELECT name FROM _migrations`).map((r) => r.name as string),
      );
      for (const mig of listMigrations('sqlite')) {
        if (applied.has(mig.name)) continue;
        db.exec(mig.sql);
        run(`INSERT INTO _migrations (name,applied_at) VALUES (?,?)`, mig.name, now());
      }
    },
    async close() {
      db.close();
    },
  };

  return repo;
}
