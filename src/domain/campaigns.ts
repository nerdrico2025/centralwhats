import type { Repo } from '../repo';
import type { CampaignConfig, Contact, CrmContact, Instance } from '../repo/types';

/** Destinatário resolvido de uma campanha (com variáveis já preenchidas). */
export interface Recipient {
  contact_id: string;
  phone: string;
  name: string | null;
  vars: Record<string, string>;
}

/**
 * Resolve uma expressão de origem de variável contra o contato + CRM.
 * Suporta: name, phone, crm.stage, crm.score, crm.custom_fields.<chave>,
 * e literais com prefixo "lit:". Origem desconhecida → string vazia.
 */
export function resolveVarSource(
  source: string,
  contact: Contact,
  crm: CrmContact | null,
): string {
  if (source === 'name') return contact.name ?? '';
  if (source === 'phone') return contact.phone;
  if (source === 'crm.stage') return crm?.stage ?? '';
  if (source === 'crm.score') return crm?.score != null ? String(crm.score) : '';
  const cf = 'crm.custom_fields.';
  if (source.startsWith(cf)) {
    const k = source.slice(cf.length);
    const v = crm?.custom_fields?.[k];
    return v != null ? String(v) : '';
  }
  if (source.startsWith('lit:')) return source.slice(4);
  return '';
}

/** Contatos distintos (dedup por id) das listas selecionadas. */
async function distinctContacts(
  repo: Repo,
  instanceId: string,
  listIds: string[],
): Promise<Contact[]> {
  const seen = new Map<string, Contact>();
  for (const lid of listIds) {
    for (const c of await repo.lists.listContacts(instanceId, lid)) {
      if (!seen.has(c.id)) seen.set(c.id, c);
    }
  }
  return [...seen.values()];
}

/** Total de destinatários (contatos distintos das listas). */
export async function countRecipients(
  repo: Repo,
  instanceId: string,
  listIds: string[],
): Promise<number> {
  return (await distinctContacts(repo, instanceId, listIds)).length;
}

/**
 * Resolve os destinatários da campanha com as variáveis preenchidas por contato.
 * `limit`/`offset` paginam a PRÉ-VISUALIZAÇÃO sem materializar tudo. NÃO envia
 * nada — só resolve (P3.1). O disparo é o P3.2.
 */
export async function resolveRecipients(
  repo: Repo,
  instance: Instance,
  config: CampaignConfig,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ total: number; recipients: Recipient[] }> {
  const contacts = await distinctContacts(repo, instance.id, config.list_ids);
  const total = contacts.length;
  const start = opts.offset ?? 0;
  const slice = opts.limit != null ? contacts.slice(start, start + opts.limit) : contacts;

  const recipients: Recipient[] = [];
  for (const c of slice) {
    const crm = await repo.crm.getByContact(instance.id, c.id);
    const vars: Record<string, string> = {};
    for (const [ph, src] of Object.entries(config.variables)) {
      vars[ph] = resolveVarSource(src, c, crm);
    }
    recipients.push({ contact_id: c.id, phone: c.phone, name: c.name, vars });
  }
  return { total, recipients };
}
