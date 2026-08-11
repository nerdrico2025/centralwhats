/**
 * Tipos das entidades persistidas. Espelham a seção "Modelo de dados" do
 * 01_PLANO_E_ARQUITETURA.md. Campos marcados [V2] ficam opcionais aqui e só
 * passam a ser usados na Fase 5 — a V1 nunca depende deles.
 */

export type ProviderType = 'meta' | 'baileys';
export type ConnectionStatus = 'connected' | 'disconnected' | 'pending';

export type MessageDirection = 'in' | 'out';
export type MessageStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed';

export type FlowExecutionStatus =
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'cancelled';

// === V2 (multi-tenancy) ===
export type UserRole = 'owner' | 'agent';

export interface Org {
  id: string;
  name: string;
  plan: string;
  created_at: string;
}

export interface User {
  id: string;
  org_id: string;
  email: string;
  role: UserRole;
  password_hash: string;
  created_at: string;
}

export interface Instance {
  id: string;
  org_id?: string | null; // [V2]
  name: string;
  provider_type: ProviderType;
  phone_number_id: string | null;
  waba_id: string | null;
  token: string | null;
  verify_token: string | null;
  active: boolean;
  baileys_session_ref?: string | null; // [V2]
  connection_status: ConnectionStatus;
  created_at?: string;
}

export interface Message {
  id: string;
  instance_id: string;
  direction: MessageDirection;
  from_number: string;
  to_number: string;
  type: string;
  content: unknown;
  status: MessageStatus;
  error_code: string | null;
  error_message: string | null;
  wa_message_id: string | null;
  campaign_id: string | null;
  created_at: string;
}

export interface Contact {
  id: string;
  instance_id: string;
  phone: string;
  name: string | null;
  /**
   * Quem escreveu `name`: 'manual' (operador) ou 'profile'/null (profile.name
   * da Meta). Plano B do PRD: a Meta pode não compartilhar o nome; quando o
   * operador corrige na mão, um profile.name posterior NÃO pode apagar a
   * correção em silêncio.
   */
  name_source: 'manual' | 'profile' | null;
  last_seen: string | null;
  last_read_at: string | null;
}

/** Métricas agregadas do Dashboard (por instância + alguns globais). */
export interface DashboardMetrics {
  sent: number;
  received: number;
  contacts: number;
  active_instances: number;
  delivery_rate: number; // 0..1 (de saída: delivered+read / total)
  read_rate: number; // 0..1 (de saída: read / total)
  volume_30d: { date: string; sent: number; received: number }[];
  by_type: { type: string; count: number }[];
  by_instance: { instance_id: string; name: string; total: number }[];
}

/** Resumo de conversa para o Live Chat (agregação por contato). */
export interface ConversationSummary {
  phone: string;
  name: string | null;
  unread: number;
  last_message_at: string;
  last_message_direction: MessageDirection;
  last_message_type: string;
  last_message_content: unknown;
}

export interface Template {
  id: string;
  instance_id: string;
  name: string;
  category: string;
  language: string;
  status: string;
  components: unknown;
  wa_template_id: string | null;
}

export interface Tag {
  id: string;
  instance_id: string;
  name: string;
  color: string | null;
}

export interface CrmContact {
  id: string;
  instance_id: string;
  contact_id: string;
  phone: string;
  name: string | null;
  stage: string | null;
  score: number | null;
  notes: string | null;
  custom_fields: Record<string, unknown>;
}

export interface ContactList {
  id: string;
  instance_id: string;
  name: string;
}

/** Config da campanha: listas alvo + mapeamento de variáveis do template. */
export interface CampaignConfig {
  list_ids: string[];
  /** placeholder do template (ex.: "1") -> expressão de origem (ex.: "name"). */
  variables: Record<string, string>;
}

export interface Campaign {
  id: string;
  instance_id: string;
  name: string;
  template_id: string | null;
  sent_count: number;
  failed_count: number;
  total_recipients: number;
  interval_ms: number;
  status: string;
  config: CampaignConfig;
  created_at: string;
}

export interface CampaignSend {
  id: string;
  campaign_id: string;
  /** Contato de origem. NOT NULL no banco: a fila nasce de contatos resolvidos. */
  contact_id: string;
  contact_phone: string;
  status: string; // pending | sending | sent | failed
  /** wamid do envio bem-sucedido — correlaciona a auditoria com a mensagem. */
  wa_message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  sent_at: string | null;
  /** Quando o lote reivindicou a linha (recupera tick morto). */
  claimed_at: string | null;
  vars: Record<string, string>;
  attempts: number;
}

export interface Flow {
  id: string;
  instance_id: string;
  name: string;
  trigger_keywords: string[];
  nodes: unknown;
  edges: unknown;
  active: boolean;
}

export interface FlowExecution {
  id: string;
  flow_id: string;
  instance_id: string;
  contact_phone: string;
  current_node_id: string | null;
  status: FlowExecutionStatus;
  variables: Record<string, unknown>;
  next_step_at: string | null;
  updated_at: string;
}

export interface FlowNodeCounter {
  flow_id: string;
  node_id: string;
  counter: number;
}

/** [V2] Item da outbox: intenção de envio da web consumida pelo worker. */
export interface OutboxItem {
  id: string;
  instance_id: string;
  to_number: string;
  payload: unknown;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  error: string | null;
  message_id: string | null;
  created_at: string;
  sent_at: string | null;
}

/** Campos de criação (id/timestamps gerados pelo adapter). */
export type NewInstance = Omit<Instance, 'id' | 'created_at'>;
// last_read_at é gerido só por markRead (não vem no upsert de contato).
// name_source é opcional: quem não informa está gravando um nome vindo da Meta
// (o caminho do webhook), e só a edição manual passa 'manual' explicitamente.
export type NewContact = Omit<Contact, 'id' | 'last_read_at' | 'name_source'> & {
  name_source?: Contact['name_source'];
};
export type NewMessage = Omit<Message, 'id' | 'created_at'> & {
  created_at?: string;
};
