/**
 * Conversões linha-do-banco ↔ entidade tipada. NÃO contém SQL — só (de)serial.
 * Compartilhado pelos dois adapters porque ambos armazenam a mesma forma
 * portável: JSON como TEXT, booleanos como INTEGER (0/1), timestamps ISO.
 */
import type {
  Campaign,
  CampaignSend,
  Contact,
  ContactList,
  CrmContact,
  Flow,
  FlowExecution,
  Instance,
  Message,
  Tag,
  Template,
} from '../types';

type Row = Record<string, unknown>;

export function toBool(v: unknown): boolean {
  return v === 1 || v === true || v === '1' || v === 't';
}
export function fromBool(b: boolean): number {
  return b ? 1 : 0;
}
export function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
export function stringifyJson(v: unknown): string | null {
  if (v == null) return null;
  return JSON.stringify(v);
}
function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}
function numOrNull(v: unknown): number | null {
  return v == null ? null : num(v);
}
function str(v: unknown): string {
  return v as string;
}
function strOrNull(v: unknown): string | null {
  return (v ?? null) as string | null;
}

export function mapOrg(r: Row): import('../types').Org {
  return {
    id: str(r.id),
    name: str(r.name),
    plan: str(r.plan),
    created_at: str(r.created_at),
  };
}

export function mapUser(r: Row): import('../types').User {
  return {
    id: str(r.id),
    org_id: str(r.org_id),
    email: str(r.email),
    role: r.role as import('../types').UserRole,
    password_hash: str(r.password_hash),
    created_at: str(r.created_at),
  };
}

export function mapOutbox(r: Row): import('../types').OutboxItem {
  return {
    id: str(r.id),
    instance_id: str(r.instance_id),
    to_number: str(r.to_number),
    payload: parseJson<unknown>(r.payload, null),
    status: r.status as import('../types').OutboxItem['status'],
    error: strOrNull(r.error),
    message_id: strOrNull(r.message_id),
    created_at: str(r.created_at),
    sent_at: strOrNull(r.sent_at),
  };
}

export function mapInstance(r: Row): Instance {
  return {
    id: str(r.id),
    org_id: strOrNull(r.org_id),
    name: str(r.name),
    provider_type: r.provider_type as Instance['provider_type'],
    phone_number_id: strOrNull(r.phone_number_id),
    waba_id: strOrNull(r.waba_id),
    token: strOrNull(r.token),
    verify_token: strOrNull(r.verify_token),
    active: toBool(r.active),
    connection_status: r.connection_status as Instance['connection_status'],
    created_at: strOrNull(r.created_at) ?? undefined,
  };
}

export function mapContact(r: Row): Contact {
  return {
    id: str(r.id),
    instance_id: str(r.instance_id),
    phone: str(r.phone),
    name: strOrNull(r.name),
    last_seen: strOrNull(r.last_seen),
    last_read_at: strOrNull(r.last_read_at),
  };
}

export function mapConversation(r: Row): import('../types').ConversationSummary {
  return {
    phone: str(r.phone),
    name: strOrNull(r.name),
    unread: num(r.unread),
    last_message_at: str(r.last_at),
    last_message_direction: r.last_direction as 'in' | 'out',
    last_message_type: str(r.last_type),
    last_message_content: parseJson<unknown>(r.last_content, null),
  };
}

export function mapMessage(r: Row): Message {
  return {
    id: str(r.id),
    instance_id: str(r.instance_id),
    direction: r.direction as Message['direction'],
    from_number: str(r.from_number),
    to_number: str(r.to_number),
    type: str(r.type),
    content: parseJson<unknown>(r.content, null),
    status: r.status as Message['status'],
    error_code: strOrNull(r.error_code),
    error_message: strOrNull(r.error_message),
    wa_message_id: strOrNull(r.wa_message_id),
    campaign_id: strOrNull(r.campaign_id),
    created_at: str(r.created_at),
  };
}

export function mapTemplate(r: Row): Template {
  return {
    id: str(r.id),
    instance_id: str(r.instance_id),
    name: str(r.name),
    category: strOrNull(r.category) ?? '',
    language: str(r.language),
    status: strOrNull(r.status) ?? '',
    components: parseJson<unknown>(r.components, null),
    wa_template_id: strOrNull(r.wa_template_id),
  };
}

export function mapTag(r: Row): Tag {
  return {
    id: str(r.id),
    instance_id: str(r.instance_id),
    name: str(r.name),
    color: strOrNull(r.color),
  };
}

export function mapCrm(r: Row): CrmContact {
  return {
    id: str(r.id),
    instance_id: str(r.instance_id),
    contact_id: str(r.contact_id),
    phone: str(r.phone),
    name: strOrNull(r.name),
    stage: strOrNull(r.stage),
    score: numOrNull(r.score),
    notes: strOrNull(r.notes),
    custom_fields: parseJson<Record<string, unknown>>(r.custom_fields, {}),
  };
}

export function mapList(r: Row): ContactList {
  return {
    id: str(r.id),
    instance_id: str(r.instance_id),
    name: str(r.name),
  };
}

export function mapCampaign(r: Row): Campaign {
  return {
    id: str(r.id),
    instance_id: str(r.instance_id),
    name: str(r.name),
    template_id: strOrNull(r.template_id),
    sent_count: num(r.sent_count),
    failed_count: num(r.failed_count),
    total_recipients: num(r.total_recipients),
    interval_ms: num(r.interval_ms),
    status: str(r.status),
    config: parseJson<import('../types').CampaignConfig>(r.config, {
      list_ids: [],
      variables: {},
    }),
    created_at: str(r.created_at),
  };
}

export function mapCampaignSend(r: Row): CampaignSend {
  return {
    id: str(r.id),
    campaign_id: str(r.campaign_id),
    contact_phone: str(r.contact_phone),
    status: str(r.status),
    error_code: strOrNull(r.error_code),
    error_message: strOrNull(r.error_message),
    sent_at: strOrNull(r.sent_at),
    vars: parseJson<Record<string, string>>(r.vars, {}),
    attempts: num(r.attempts ?? 0),
  };
}

export function mapFlow(r: Row): Flow {
  return {
    id: str(r.id),
    instance_id: str(r.instance_id),
    name: str(r.name),
    trigger_keywords: parseJson<string[]>(r.trigger_keywords, []),
    nodes: parseJson<unknown>(r.nodes, []),
    edges: parseJson<unknown>(r.edges, []),
    active: toBool(r.active),
  };
}

export function mapFlowExecution(r: Row): FlowExecution {
  return {
    id: str(r.id),
    flow_id: str(r.flow_id),
    instance_id: str(r.instance_id),
    contact_phone: str(r.contact_phone),
    current_node_id: strOrNull(r.current_node_id),
    status: r.status as FlowExecution['status'],
    variables: parseJson<Record<string, unknown>>(r.variables, {}),
    next_step_at: strOrNull(r.next_step_at),
    updated_at: str(r.updated_at),
  };
}
