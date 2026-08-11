import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { normalizePhone } from '../../util/phone';
import { listMigrations } from '../../util/paths';
import { buildVolumeSeries } from '../../util/metrics';
import type { Repo } from '../Repo';
import type { Campaign, Flow, FlowExecution } from '../types';
import * as m from './mappers';

/**
 * Adapter Postgres (prod, Supabase), via `pg` (JS puro, sem build nativo).
 * ÚNICO lugar (junto do SqliteAdapter) onde SQL cru pode existir.
 * Espelha o SqliteAdapter — mesma semântica, placeholders $n e API async.
 *
 * Convenções portáveis idênticas ao SQLite: JSON como TEXT, booleanos como
 * INTEGER (0/1), timestamps ISO. Assim as duas migrations ficam em espelho.
 */
export function createPostgresAdapter(opts: { connectionString: string }): Repo {
  const pool = new Pool({ connectionString: opts.connectionString });

  const now = (): string => new Date().toISOString();
  const uid = (): string => randomUUID();

  type Row = Record<string, unknown>;
  const get = async (sql: string, p: unknown[] = []): Promise<Row | undefined> =>
    (await pool.query(sql, p)).rows[0] as Row | undefined;
  const all = async (sql: string, p: unknown[] = []): Promise<Row[]> =>
    (await pool.query(sql, p)).rows as Row[];
  const run = async (sql: string, p: unknown[] = []): Promise<number> =>
    (await pool.query(sql, p)).rowCount ?? 0;

  /** Gera "$a,$b,..." a partir de um índice inicial, para cláusulas IN. */
  const inPlaceholders = (start: number, count: number): string =>
    Array.from({ length: count }, (_, i) => `$${start + i}`).join(',');

  // Alvo humano-legível SEM credenciais (para logs de migrate/boot).
  let target = 'postgres';
  try {
    const u = new URL(opts.connectionString);
    target = `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    /* connection string fora do formato URL — mantém o genérico */
  }

  const repo: Repo = {
    driver: 'postgres',
    target,
    instances: {
      async create(data) {
        const id = uid();
        await run(
          `INSERT INTO instances
             (id,org_id,name,provider_type,phone_number_id,waba_id,token,verify_token,active,connection_status,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            data.org_id ?? 'org_default',
            data.name,
            data.provider_type ?? 'meta',
            data.phone_number_id,
            data.waba_id,
            data.token,
            data.verify_token,
            m.fromBool(data.active ?? true),
            data.connection_status ?? 'disconnected',
            now(),
          ],
        );
        return (await this.getById(id))!;
      },
      async getById(id) {
        const r = await get(`SELECT * FROM instances WHERE id=$1`, [id]);
        return r ? m.mapInstance(r) : null;
      },
      async list(orgId) {
        if (orgId) {
          return (
            await all(`SELECT * FROM instances WHERE org_id=$1 ORDER BY created_at ASC`, [orgId])
          ).map(m.mapInstance);
        }
        return (await all(`SELECT * FROM instances ORDER BY created_at ASC`)).map(m.mapInstance);
      },
      async update(id, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          vals.push(v);
          cols.push(`${c}=$${vals.length}`);
        };
        if (patch.name !== undefined) set('name', patch.name);
        if (patch.org_id !== undefined) set('org_id', patch.org_id);
        if (patch.provider_type !== undefined) set('provider_type', patch.provider_type);
        if (patch.phone_number_id !== undefined) set('phone_number_id', patch.phone_number_id);
        if (patch.waba_id !== undefined) set('waba_id', patch.waba_id);
        if (patch.token !== undefined) set('token', patch.token);
        if (patch.verify_token !== undefined) set('verify_token', patch.verify_token);
        if (patch.active !== undefined) set('active', m.fromBool(patch.active));
        if (patch.connection_status !== undefined)
          set('connection_status', patch.connection_status);
        if (cols.length) {
          vals.push(id);
          await run(`UPDATE instances SET ${cols.join(',')} WHERE id=$${vals.length}`, vals);
        }
        return this.getById(id);
      },
      async delete(id) {
        await run(`DELETE FROM instances WHERE id=$1`, [id]);
      },
      async getByPhoneNumberId(phoneNumberId) {
        const r = await get(`SELECT * FROM instances WHERE phone_number_id=$1`, [phoneNumberId]);
        return r ? m.mapInstance(r) : null;
      },
    },

    messages: {
      async create(data) {
        const id = uid();
        const r = await get(
          `INSERT INTO messages
             (id,instance_id,direction,from_number,to_number,type,content,status,error_code,error_message,wa_message_id,campaign_id,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
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
          ],
        );
        return m.mapMessage(r!);
      },
      async getByWaMessageId(instanceId, waMessageId) {
        const r = await get(
          `SELECT * FROM messages WHERE instance_id=$1 AND wa_message_id=$2`,
          [instanceId, waMessageId],
        );
        return r ? m.mapMessage(r) : null;
      },
      async updateStatusByWaMessageId(instanceId, waMessageId, patch) {
        await run(
          `UPDATE messages SET status=$1, error_code=$2, error_message=$3
             WHERE instance_id=$4 AND wa_message_id=$5`,
          [patch.status, patch.error_code, patch.error_message, instanceId, waMessageId],
        );
      },
      async updateById(id, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          vals.push(v);
          cols.push(`${c}=$${vals.length}`);
        };
        if (patch.status !== undefined) set('status', patch.status);
        if (patch.error_code !== undefined) set('error_code', patch.error_code);
        if (patch.error_message !== undefined) set('error_message', patch.error_message);
        if (patch.wa_message_id !== undefined) set('wa_message_id', patch.wa_message_id);
        if (!cols.length) return;
        vals.push(id);
        await run(`UPDATE messages SET ${cols.join(',')} WHERE id=$${vals.length}`, vals);
      },
      async listByContact(instanceId, phone, o) {
        const p = normalizePhone(phone);
        const limit = o?.limit ?? 50;
        if (o?.before) {
          return (
            await all(
              `SELECT * FROM messages
                 WHERE instance_id=$1 AND (from_number=$2 OR to_number=$2) AND created_at < $3
                 ORDER BY created_at DESC LIMIT $4`,
              [instanceId, p, o.before, limit],
            )
          ).map(m.mapMessage);
        }
        return (
          await all(
            `SELECT * FROM messages
               WHERE instance_id=$1 AND (from_number=$2 OR to_number=$2)
               ORDER BY created_at DESC LIMIT $3`,
            [instanceId, p, limit],
          )
        ).map(m.mapMessage);
      },
      async listConversations(instanceId) {
        // Ver comentário no SqliteAdapter — mesma query com window functions.
        const rows = await all(
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
                 FROM messages WHERE instance_id=$1
               ) msg
               LEFT JOIN contacts c ON c.instance_id=$1 AND c.phone=msg.conv_phone
             ) t
             WHERE rn=1
             ORDER BY last_at DESC`,
          [instanceId],
        );
        return rows.map(m.mapConversation);
      },
    },

    contacts: {
      async upsert(data) {
        const r = await get(
          `INSERT INTO contacts (id,instance_id,phone,name,last_seen)
             VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT(instance_id,phone) DO UPDATE SET
             name = COALESCE(excluded.name, contacts.name),
             last_seen = COALESCE(excluded.last_seen, contacts.last_seen)
           RETURNING *`,
          [uid(), data.instance_id, normalizePhone(data.phone), data.name, data.last_seen],
        );
        return m.mapContact(r!);
      },
      async getById(instanceId, id) {
        const r = await get(`SELECT * FROM contacts WHERE instance_id=$1 AND id=$2`, [
          instanceId,
          id,
        ]);
        return r ? m.mapContact(r) : null;
      },
      async getByPhone(instanceId, phone) {
        const r = await get(`SELECT * FROM contacts WHERE instance_id=$1 AND phone=$2`, [
          instanceId,
          normalizePhone(phone),
        ]);
        return r ? m.mapContact(r) : null;
      },
      async list(instanceId, o) {
        if (o?.search) {
          const like = `%${o.search}%`;
          return (
            await all(
              `SELECT * FROM contacts WHERE instance_id=$1 AND (name LIKE $2 OR phone LIKE $2)
                 ORDER BY name ASC`,
              [instanceId, like],
            )
          ).map(m.mapContact);
        }
        return (
          await all(`SELECT * FROM contacts WHERE instance_id=$1 ORDER BY name ASC`, [instanceId])
        ).map(m.mapContact);
      },
      async touchLastSeen(instanceId, phone, at) {
        await run(`UPDATE contacts SET last_seen=$1 WHERE instance_id=$2 AND phone=$3`, [
          at,
          instanceId,
          normalizePhone(phone),
        ]);
      },
      async markRead(instanceId, phone, at) {
        await run(`UPDATE contacts SET last_read_at=$1 WHERE instance_id=$2 AND phone=$3`, [
          at,
          instanceId,
          normalizePhone(phone),
        ]);
      },
    },

    templates: {
      async upsert(data) {
        const r = await get(
          `INSERT INTO templates (id,instance_id,name,category,language,status,components,wa_template_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT(instance_id,name,language) DO UPDATE SET
             category=excluded.category, status=excluded.status,
             components=excluded.components, wa_template_id=excluded.wa_template_id
           RETURNING *`,
          [
            uid(),
            data.instance_id,
            data.name,
            data.category,
            data.language,
            data.status,
            m.stringifyJson(data.components),
            data.wa_template_id,
          ],
        );
        return m.mapTemplate(r!);
      },
      async list(instanceId) {
        return (
          await all(`SELECT * FROM templates WHERE instance_id=$1 ORDER BY name ASC`, [instanceId])
        ).map(m.mapTemplate);
      },
      async getById(instanceId, id) {
        const r = await get(`SELECT * FROM templates WHERE instance_id=$1 AND id=$2`, [
          instanceId,
          id,
        ]);
        return r ? m.mapTemplate(r) : null;
      },
      async getByName(instanceId, name, language) {
        const r = language
          ? await get(
              `SELECT * FROM templates WHERE instance_id=$1 AND name=$2 AND language=$3`,
              [instanceId, name, language],
            )
          : await get(`SELECT * FROM templates WHERE instance_id=$1 AND name=$2`, [
              instanceId,
              name,
            ]);
        return r ? m.mapTemplate(r) : null;
      },
    },

    tags: {
      async create(data) {
        const r = await get(
          `INSERT INTO tags (id,instance_id,name,color) VALUES ($1,$2,$3,$4) RETURNING *`,
          [uid(), data.instance_id, data.name, data.color],
        );
        return m.mapTag(r!);
      },
      async list(instanceId) {
        return (
          await all(`SELECT * FROM tags WHERE instance_id=$1 ORDER BY name ASC`, [instanceId])
        ).map(m.mapTag);
      },
      async delete(instanceId, id) {
        await run(`DELETE FROM tags WHERE instance_id=$1 AND id=$2`, [instanceId, id]);
      },
      async applyToContacts(instanceId, tagId, contactIds) {
        if (!contactIds.length) return;
        const tag = await get(`SELECT id FROM tags WHERE instance_id=$1 AND id=$2`, [
          instanceId,
          tagId,
        ]);
        if (!tag) return;
        const valid = (
          await all(
            `SELECT id FROM contacts WHERE instance_id=$1 AND id IN (${inPlaceholders(2, contactIds.length)})`,
            [instanceId, ...contactIds],
          )
        ).map((r) => r.id as string);
        for (const cid of valid) {
          await run(
            `INSERT INTO contact_tags (contact_id,tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [cid, tagId],
          );
        }
      },
      async removeFromContacts(instanceId, tagId, contactIds) {
        if (!contactIds.length) return;
        const tag = await get(`SELECT id FROM tags WHERE instance_id=$1 AND id=$2`, [
          instanceId,
          tagId,
        ]);
        if (!tag) return;
        await run(
          `DELETE FROM contact_tags WHERE tag_id=$1 AND contact_id IN (${inPlaceholders(2, contactIds.length)})`,
          [tagId, ...contactIds],
        );
      },
      async listForContact(instanceId, contactId) {
        return (
          await all(
            `SELECT t.* FROM tags t
               JOIN contact_tags ct ON ct.tag_id = t.id
               WHERE t.instance_id=$1 AND ct.contact_id=$2
               ORDER BY t.name ASC`,
            [instanceId, contactId],
          )
        ).map(m.mapTag);
      },
    },

    crm: {
      async upsert(data) {
        const r = await get(
          `INSERT INTO crm_contacts (id,instance_id,contact_id,phone,name,stage,score,notes,custom_fields)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(instance_id,contact_id) DO UPDATE SET
             phone=excluded.phone, name=excluded.name, stage=excluded.stage,
             score=excluded.score, notes=excluded.notes, custom_fields=excluded.custom_fields
           RETURNING *`,
          [
            uid(),
            data.instance_id,
            data.contact_id,
            normalizePhone(data.phone),
            data.name,
            data.stage,
            data.score,
            data.notes,
            m.stringifyJson(data.custom_fields ?? {}),
          ],
        );
        return m.mapCrm(r!);
      },
      async getByContact(instanceId, contactId) {
        const r = await get(
          `SELECT * FROM crm_contacts WHERE instance_id=$1 AND contact_id=$2`,
          [instanceId, contactId],
        );
        return r ? m.mapCrm(r) : null;
      },
      async list(instanceId, o) {
        const rows = o?.stage
          ? await all(
              `SELECT * FROM crm_contacts WHERE instance_id=$1 AND stage=$2 ORDER BY name ASC`,
              [instanceId, o.stage],
            )
          : await all(`SELECT * FROM crm_contacts WHERE instance_id=$1 ORDER BY name ASC`, [
              instanceId,
            ]);
        return rows.map(m.mapCrm);
      },
    },

    lists: {
      async create(data) {
        const r = await get(
          `INSERT INTO contact_lists (id,instance_id,name) VALUES ($1,$2,$3) RETURNING *`,
          [uid(), data.instance_id, data.name],
        );
        return m.mapList(r!);
      },
      async list(instanceId) {
        return (
          await all(`SELECT * FROM contact_lists WHERE instance_id=$1 ORDER BY name ASC`, [
            instanceId,
          ])
        ).map(m.mapList);
      },
      async delete(instanceId, id) {
        await run(`DELETE FROM contact_lists WHERE instance_id=$1 AND id=$2`, [instanceId, id]);
      },
      async addContacts(instanceId, listId, contactIds) {
        if (!contactIds.length) return;
        const list = await get(`SELECT id FROM contact_lists WHERE instance_id=$1 AND id=$2`, [
          instanceId,
          listId,
        ]);
        if (!list) return;
        const valid = (
          await all(
            `SELECT id FROM contacts WHERE instance_id=$1 AND id IN (${inPlaceholders(2, contactIds.length)})`,
            [instanceId, ...contactIds],
          )
        ).map((r) => r.id as string);
        for (const cid of valid) {
          await run(
            `INSERT INTO list_contacts (list_id,contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [listId, cid],
          );
        }
      },
      async removeContacts(instanceId, listId, contactIds) {
        if (!contactIds.length) return;
        const list = await get(`SELECT id FROM contact_lists WHERE instance_id=$1 AND id=$2`, [
          instanceId,
          listId,
        ]);
        if (!list) return;
        await run(
          `DELETE FROM list_contacts WHERE list_id=$1 AND contact_id IN (${inPlaceholders(2, contactIds.length)})`,
          [listId, ...contactIds],
        );
      },
      async listContacts(instanceId, listId) {
        return (
          await all(
            `SELECT c.* FROM contacts c
               JOIN list_contacts lc ON lc.contact_id = c.id
               JOIN contact_lists cl ON cl.id = lc.list_id
               WHERE cl.instance_id=$1 AND cl.id=$2
               ORDER BY c.name ASC`,
            [instanceId, listId],
          )
        ).map(m.mapContact);
      },
    },

    campaigns: {
      async create(data) {
        const r = await get(
          `INSERT INTO campaigns
             (id,instance_id,name,template_id,sent_count,failed_count,total_recipients,interval_ms,status,config,created_at)
           VALUES ($1,$2,$3,$4,0,0,$5,$6,$7,$8,$9) RETURNING *`,
          [
            uid(),
            data.instance_id,
            data.name,
            data.template_id,
            data.total_recipients ?? 0,
            data.interval_ms ?? 1000,
            data.status ?? 'draft',
            m.stringifyJson(data.config ?? { list_ids: [], variables: {} }),
            now(),
          ],
        );
        return m.mapCampaign(r!);
      },
      async getById(instanceId, id) {
        const r = await get(`SELECT * FROM campaigns WHERE instance_id=$1 AND id=$2`, [
          instanceId,
          id,
        ]);
        return r ? m.mapCampaign(r) : null;
      },
      async list(instanceId) {
        return (
          await all(`SELECT * FROM campaigns WHERE instance_id=$1 ORDER BY created_at DESC`, [
            instanceId,
          ])
        ).map(m.mapCampaign);
      },
      async update(instanceId, id, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          vals.push(v);
          cols.push(`${c}=$${vals.length}`);
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
          await run(
            `UPDATE campaigns SET ${cols.join(',')} WHERE instance_id=$${vals.length - 1} AND id=$${vals.length}`,
            vals,
          );
        }
        return this.getById(instanceId, id) as Promise<Campaign | null>;
      },
      async delete(instanceId, id) {
        // campaign_sends cai junto via ON DELETE CASCADE (001_init.sql).
        const n = await run(`DELETE FROM campaigns WHERE instance_id=$1 AND id=$2`, [
          instanceId,
          id,
        ]);
        return n > 0;
      },
      async recordSend(data) {
        const r = await get(
          `INSERT INTO campaign_sends (id,campaign_id,contact_id,contact_phone,status,wa_message_id,error_code,error_message,sent_at,claimed_at,vars,attempts)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            uid(),
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
          ],
        );
        return m.mapCampaignSend(r!);
      },
      async listSends(campaignId) {
        return (
          await all(`SELECT * FROM campaign_sends WHERE campaign_id=$1 ORDER BY sent_at ASC`, [
            campaignId,
          ])
        ).map(m.mapCampaignSend);
      },
      async listPendingSends(campaignId, limit) {
        return (
          await all(
            `SELECT * FROM campaign_sends WHERE campaign_id=$1 AND status='pending'
               ORDER BY id ASC LIMIT $2`,
            [campaignId, limit],
          )
        ).map(m.mapCampaignSend);
      },
      async listSendsByStatus(campaignId, status) {
        return (
          await all(
            `SELECT * FROM campaign_sends WHERE campaign_id=$1 AND status=$2 ORDER BY id ASC`,
            [campaignId, status],
          )
        ).map(m.mapCampaignSend);
      },
      async claimPendingSends(campaignId, limit, claimedAt) {
        // UMA instrução: seleciona e marca no mesmo UPDATE, com SKIP LOCKED
        // para que dois ticks concorrentes (polling da UI + retomada por
        // webhook) nunca peguem o mesmo destinatário — nada de envio duplicado.
        return (
          await all(
            `UPDATE campaign_sends SET status='sending', claimed_at=$3
               WHERE id IN (
                 SELECT id FROM campaign_sends
                   WHERE campaign_id=$1 AND status='pending'
                   ORDER BY id ASC LIMIT $2
                   FOR UPDATE SKIP LOCKED
               )
               RETURNING *`,
            [campaignId, limit, claimedAt],
          )
        ).map(m.mapCampaignSend);
      },
      async reclaimStaleSends(campaignId, olderThan) {
        const rows = await all(
          `UPDATE campaign_sends SET status='pending', claimed_at=NULL
             WHERE campaign_id=$1 AND status='sending' AND claimed_at < $2
             RETURNING id`,
          [campaignId, olderThan],
        );
        return rows.length;
      },
      async updateSend(id, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          vals.push(v);
          cols.push(`${c}=$${vals.length}`);
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
        await run(`UPDATE campaign_sends SET ${cols.join(',')} WHERE id=$${vals.length}`, vals);
      },
      async markSendFailedByWaMessageId(instanceId, waMessageId, errorCode, errorMessage) {
        // Escopado pela instância da campanha (multi-tenancy) mesmo o wamid
        // sendo único na Meta. Só afeta linhas ainda tidas como 'sent'.
        const rows = await all(
          `UPDATE campaign_sends SET status='failed', error_code=$1, error_message=$2
             WHERE wa_message_id=$3 AND status='sent'
               AND campaign_id IN (SELECT id FROM campaigns WHERE instance_id=$4)
             RETURNING campaign_id`,
          [errorCode, errorMessage, waMessageId, instanceId],
        );
        return rows.length ? String(rows[0].campaign_id) : null;
      },
      async countSendsByStatus(campaignId) {
        const rows = await all(
          `SELECT status, COUNT(*) c FROM campaign_sends WHERE campaign_id=$1 GROUP BY status`,
          [campaignId],
        );
        const g = (s: string): number => Number(rows.find((r) => r.status === s)?.c ?? 0);
        // 'sending' (em voo) conta como pendente: senão a campanha seria dada
        // como concluída com envios ainda acontecendo.
        return { sent: g('sent'), failed: g('failed'), pending: g('pending') + g('sending') };
      },
    },

    flows: {
      async create(data) {
        const r = await get(
          `INSERT INTO flows (id,instance_id,name,trigger_keywords,nodes,edges,active)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            uid(),
            data.instance_id,
            data.name,
            m.stringifyJson(data.trigger_keywords ?? []),
            m.stringifyJson(data.nodes ?? []),
            m.stringifyJson(data.edges ?? []),
            m.fromBool(data.active ?? false),
          ],
        );
        return m.mapFlow(r!);
      },
      async getById(instanceId, id) {
        const r = await get(`SELECT * FROM flows WHERE instance_id=$1 AND id=$2`, [
          instanceId,
          id,
        ]);
        return r ? m.mapFlow(r) : null;
      },
      async list(instanceId) {
        return (
          await all(`SELECT * FROM flows WHERE instance_id=$1 ORDER BY name ASC`, [instanceId])
        ).map(m.mapFlow);
      },
      async update(instanceId, id, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          vals.push(v);
          cols.push(`${c}=$${vals.length}`);
        };
        if (patch.name !== undefined) set('name', patch.name);
        if (patch.trigger_keywords !== undefined)
          set('trigger_keywords', m.stringifyJson(patch.trigger_keywords));
        if (patch.nodes !== undefined) set('nodes', m.stringifyJson(patch.nodes));
        if (patch.edges !== undefined) set('edges', m.stringifyJson(patch.edges));
        if (patch.active !== undefined) set('active', m.fromBool(patch.active));
        if (cols.length) {
          vals.push(instanceId, id);
          await run(
            `UPDATE flows SET ${cols.join(',')} WHERE instance_id=$${vals.length - 1} AND id=$${vals.length}`,
            vals,
          );
        }
        return this.getById(instanceId, id) as Promise<Flow | null>;
      },
      async findByTriggerKeyword(instanceId, keyword) {
        const kw = keyword.trim().toLowerCase();
        const rows = (
          await all(`SELECT * FROM flows WHERE instance_id=$1 AND active=1`, [instanceId])
        ).map(m.mapFlow);
        return rows.filter((f) =>
          f.trigger_keywords.some((k) => k.trim().toLowerCase() === kw),
        );
      },
    },

    flowExecutions: {
      async create(data) {
        const r = await get(
          `INSERT INTO flow_executions
             (id,flow_id,instance_id,contact_phone,current_node_id,status,variables,next_step_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            uid(),
            data.flow_id,
            data.instance_id,
            normalizePhone(data.contact_phone),
            data.current_node_id,
            data.status ?? 'running',
            m.stringifyJson(data.variables ?? {}),
            data.next_step_at,
            now(),
          ],
        );
        return m.mapFlowExecution(r!);
      },
      async getById(id) {
        const r = await get(`SELECT * FROM flow_executions WHERE id=$1`, [id]);
        return r ? m.mapFlowExecution(r) : null;
      },
      async listDue(instanceId, nowIso) {
        return (
          await all(
            `SELECT * FROM flow_executions
               WHERE instance_id=$1 AND status IN ('running','waiting_input')
                 AND next_step_at IS NOT NULL AND next_step_at <= $2
               ORDER BY next_step_at ASC`,
            [instanceId, nowIso],
          )
        ).map(m.mapFlowExecution);
      },
      async findActiveByFlowAndContact(flowId, contactPhone) {
        const r = await get(
          `SELECT * FROM flow_executions
             WHERE flow_id=$1 AND contact_phone=$2 AND status IN ('running','waiting_input')
             ORDER BY updated_at DESC LIMIT 1`,
          [flowId, normalizePhone(contactPhone)],
        );
        return r ? m.mapFlowExecution(r) : null;
      },
      async findWaitingByContact(instanceId, contactPhone) {
        const r = await get(
          `SELECT * FROM flow_executions
             WHERE instance_id=$1 AND contact_phone=$2 AND status='waiting_input'
             ORDER BY updated_at DESC LIMIT 1`,
          [instanceId, normalizePhone(contactPhone)],
        );
        return r ? m.mapFlowExecution(r) : null;
      },
      async listActiveByFlow(flowId) {
        return (
          await all(
            `SELECT * FROM flow_executions
               WHERE flow_id=$1 AND status IN ('running','waiting_input')
               ORDER BY updated_at DESC`,
            [flowId],
          )
        ).map(m.mapFlowExecution);
      },
      async updateIfStatus(id, expectedStatus, patch) {
        const cols: string[] = [];
        const vals: unknown[] = [];
        const set = (c: string, v: unknown): void => {
          vals.push(v);
          cols.push(`${c}=$${vals.length}`);
        };
        if (patch.status !== undefined) set('status', patch.status);
        if (patch.current_node_id !== undefined) set('current_node_id', patch.current_node_id);
        if (patch.variables !== undefined) set('variables', m.stringifyJson(patch.variables));
        if (patch.next_step_at !== undefined) set('next_step_at', patch.next_step_at);
        set('updated_at', now());
        vals.push(id, expectedStatus);
        const changed = await run(
          `UPDATE flow_executions SET ${cols.join(',')}
             WHERE id=$${vals.length - 1} AND status=$${vals.length}`,
          vals,
        );
        if (changed === 0) return null;
        return this.getById(id) as Promise<FlowExecution | null>;
      },
      async claimDue(id, nowIso) {
        // Ver comentário no SqliteAdapter — claim atômico de retomada.
        const changed = await run(
          `UPDATE flow_executions SET next_step_at=NULL, updated_at=$1
             WHERE id=$2 AND next_step_at IS NOT NULL AND next_step_at <= $3
               AND status IN ('running','waiting_input')`,
          [now(), id, nowIso],
        );
        if (changed === 0) return null;
        return this.getById(id) as Promise<FlowExecution | null>;
      },
      async cancelStuck(instanceId, cutoffIso) {
        return run(
          `UPDATE flow_executions SET status='cancelled', updated_at=$1
             WHERE instance_id=$2 AND status IN ('running','waiting_input')
               AND updated_at < $3
               AND (next_step_at IS NULL OR next_step_at < $3)`,
          [now(), instanceId, cutoffIso],
        );
      },
    },

    flowNodeCounters: {
      async incrementAndGet(flowId, nodeId, n) {
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`incrementAndGet: n inválido (${n})`);
        }
        // LIÇÃO Nº 3: UMA única instrução SQL atômica. Nunca ler→somar→salvar.
        const r = await get(
          `INSERT INTO flow_node_counters (flow_id,node_id,counter) VALUES ($1,$2,0)
             ON CONFLICT(flow_id,node_id) DO UPDATE SET counter=(flow_node_counters.counter + 1) % $3
           RETURNING counter`,
          [flowId, nodeId, n],
        );
        return Number((r as { counter: number }).counter);
      },
    },

    orgs: {
      async create(data) {
        const r = await get(
          `INSERT INTO orgs (id,name,plan,created_at) VALUES ($1,$2,$3,$4) RETURNING *`,
          [uid(), data.name, data.plan ?? 'free', now()],
        );
        return m.mapOrg(r!);
      },
      async getById(id) {
        const r = await get(`SELECT * FROM orgs WHERE id=$1`, [id]);
        return r ? m.mapOrg(r) : null;
      },
    },

    users: {
      async create(data) {
        const r = await get(
          `INSERT INTO users (id,org_id,email,role,password_hash,created_at)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            uid(),
            data.org_id,
            data.email.trim().toLowerCase(),
            data.role ?? 'agent',
            data.password_hash,
            now(),
          ],
        );
        return m.mapUser(r!);
      },
      async getByEmail(email) {
        const r = await get(`SELECT * FROM users WHERE email=$1`, [email.trim().toLowerCase()]);
        return r ? m.mapUser(r) : null;
      },
      async getById(id) {
        const r = await get(`SELECT * FROM users WHERE id=$1`, [id]);
        return r ? m.mapUser(r) : null;
      },
      async listByOrg(orgId) {
        return (
          await all(`SELECT * FROM users WHERE org_id=$1 ORDER BY created_at ASC`, [orgId])
        ).map(m.mapUser);
      },
      async countAll() {
        return Number((await get(`SELECT COUNT(*) c FROM users`))?.c ?? 0);
      },
    },

    outbox: {
      async enqueue(data) {
        const r = await get(
          `INSERT INTO outbox (id,instance_id,to_number,payload,status,error,message_id,created_at,sent_at)
             VALUES ($1,$2,$3,$4,'pending',NULL,$5,$6,NULL) RETURNING *`,
          [
            uid(),
            data.instance_id,
            normalizePhone(data.to_number),
            m.stringifyJson(data.payload),
            data.message_id,
            now(),
          ],
        );
        return m.mapOutbox(r!);
      },
      async claimPending(instanceId, limit) {
        const candidates = await all(
          `SELECT id FROM outbox WHERE instance_id=$1 AND status='pending'
             ORDER BY created_at ASC LIMIT $2`,
          [instanceId, limit],
        );
        const claimed: string[] = [];
        for (const c of candidates) {
          const changed = await run(
            `UPDATE outbox SET status='sending' WHERE id=$1 AND status='pending'`,
            [c.id],
          );
          if (changed > 0) claimed.push(c.id as string);
        }
        if (!claimed.length) return [];
        return (
          await all(
            `SELECT * FROM outbox WHERE id IN (${inPlaceholders(1, claimed.length)})`,
            claimed,
          )
        ).map(m.mapOutbox);
      },
      async markSent(id) {
        await run(`UPDATE outbox SET status='sent', sent_at=$1, error=NULL WHERE id=$2`, [
          now(),
          id,
        ]);
      },
      async setMessageId(id, messageId) {
        await run(`UPDATE outbox SET message_id=$1 WHERE id=$2`, [messageId, id]);
      },
      async markFailed(id, error) {
        await run(`UPDATE outbox SET status='failed', sent_at=$1, error=$2 WHERE id=$3`, [
          now(),
          error,
          id,
        ]);
      },
      async listByInstance(instanceId, status) {
        const rows = status
          ? await all(
              `SELECT * FROM outbox WHERE instance_id=$1 AND status=$2 ORDER BY created_at ASC`,
              [instanceId, status],
            )
          : await all(`SELECT * FROM outbox WHERE instance_id=$1 ORDER BY created_at ASC`, [
              instanceId,
            ]);
        return rows.map(m.mapOutbox);
      },
    },

    baileysAuth: {
      async get(instanceId, key) {
        const r = await get(`SELECT value FROM baileys_auth WHERE instance_id=$1 AND key=$2`, [
          instanceId,
          key,
        ]);
        return r ? m.parseJson<unknown>(r.value, null) : null;
      },
      async set(instanceId, key, value) {
        await run(
          `INSERT INTO baileys_auth (instance_id,key,value,updated_at) VALUES ($1,$2,$3,$4)
             ON CONFLICT(instance_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
          [instanceId, key, m.stringifyJson(value), now()],
        );
      },
      async delete(instanceId, key) {
        await run(`DELETE FROM baileys_auth WHERE instance_id=$1 AND key=$2`, [instanceId, key]);
      },
      async listKeys(instanceId) {
        return (await all(`SELECT key FROM baileys_auth WHERE instance_id=$1`, [instanceId])).map(
          (r) => r.key as string,
        );
      },
      async clear(instanceId) {
        await run(`DELETE FROM baileys_auth WHERE instance_id=$1`, [instanceId]);
      },
    },

    metrics: {
      async dashboard(instanceId, orgId) {
        const dir = await all(
          `SELECT direction, COUNT(*) c FROM messages WHERE instance_id=$1 GROUP BY direction`,
          [instanceId],
        );
        const sent = Number(dir.find((r) => r.direction === 'out')?.c ?? 0);
        const received = Number(dir.find((r) => r.direction === 'in')?.c ?? 0);

        const contacts = Number(
          (await get(`SELECT COUNT(*) c FROM contacts WHERE instance_id=$1`, [instanceId]))?.c ?? 0,
        );
        const activeInstances = orgId
          ? Number(
              (await get(`SELECT COUNT(*) c FROM instances WHERE active=1 AND org_id=$1`, [orgId]))
                ?.c ?? 0,
            )
          : Number((await get(`SELECT COUNT(*) c FROM instances WHERE active=1`))?.c ?? 0);

        const outStatus = await all(
          `SELECT status, COUNT(*) c FROM messages
             WHERE instance_id=$1 AND direction='out' GROUP BY status`,
          [instanceId],
        );
        const outTotal = outStatus.reduce((s, r) => s + Number(r.c), 0);
        const deliveredOrBetter = outStatus
          .filter((r) => r.status === 'delivered' || r.status === 'read')
          .reduce((s, r) => s + Number(r.c), 0);
        const readCount = Number(outStatus.find((r) => r.status === 'read')?.c ?? 0);

        const since = new Date();
        since.setUTCDate(since.getUTCDate() - 29);
        const sinceIso = since.toISOString().slice(0, 10);
        const volRows = (
          await all(
            `SELECT substr(created_at,1,10) d, direction, COUNT(*) c FROM messages
               WHERE instance_id=$1 AND substr(created_at,1,10) >= $2 GROUP BY d, direction`,
            [instanceId, sinceIso],
          )
        ).map((r) => ({ d: String(r.d), direction: String(r.direction), c: Number(r.c) }));

        const byType = (
          await all(
            `SELECT type, COUNT(*) c FROM messages WHERE instance_id=$1 GROUP BY type ORDER BY c DESC`,
            [instanceId],
          )
        ).map((r) => ({ type: String(r.type), count: Number(r.c) }));

        const byInstance = (
          orgId
            ? await all(
                `SELECT i.id, i.name, COUNT(m.id) c FROM instances i
                   LEFT JOIN messages m ON m.instance_id=i.id
                   WHERE i.org_id=$1
                   GROUP BY i.id, i.name ORDER BY c DESC`,
                [orgId],
              )
            : await all(
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

    async migrate() {
      await run(
        `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
      );
      const applied = new Set(
        (await all(`SELECT name FROM _migrations`)).map((r) => r.name as string),
      );
      for (const mig of listMigrations('postgres')) {
        if (applied.has(mig.name)) continue;
        await pool.query(mig.sql);
        await run(`INSERT INTO _migrations (name,applied_at) VALUES ($1,$2)`, [mig.name, now()]);
      }
    },
    async close() {
      await pool.end();
    },
  };

  return repo;
}
