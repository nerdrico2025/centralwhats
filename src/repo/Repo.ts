import type {
  Campaign,
  CampaignSend,
  Contact,
  ContactList,
  ConversationSummary,
  CrmContact,
  DashboardMetrics,
  Flow,
  FlowExecution,
  Instance,
  Message,
  NewContact,
  NewInstance,
  NewMessage,
  Org,
  OutboxItem,
  Tag,
  Template,
  User,
} from './types';

/**
 * Interface única de acesso a dados. TODA leitura/escrita passa por aqui.
 * Nenhum SQL cru fora dos adapters (SqliteAdapter / PostgresAdapter).
 *
 * Regra de escopo: métodos que operam sobre dados de tenant recebem e filtram
 * por instance_id. Exceções (ex.: resolver instância por phone_number_id) são
 * justificadas caso a caso.
 *
 * NOTA (P0.1): apenas assinaturas. Os corpos são implementados em P0.2.
 */
export interface Repo {
  /** Driver ativo — para logs e sanidade (nunca confie no "deve ser"). */
  readonly driver: 'sqlite' | 'postgres';
  /** Alvo humano-legível: caminho do arquivo ou host:porta/banco (SEM credenciais). */
  readonly target: string;

  instances: InstancesRepo;
  messages: MessagesRepo;
  contacts: ContactsRepo;
  templates: TemplatesRepo;
  tags: TagsRepo;
  crm: CrmRepo;
  lists: ListsRepo;
  campaigns: CampaignsRepo;
  flows: FlowsRepo;
  flowExecutions: FlowExecutionsRepo;
  flowNodeCounters: FlowNodeCountersRepo;
  metrics: MetricsRepo;
  orgs: OrgsRepo; // [V2]
  users: UsersRepo; // [V2]
  outbox: OutboxRepo; // [V2]
  baileysAuth: BaileysAuthRepo; // [V2]

  /** Roda as migrations pendentes para o driver ativo. */
  migrate(): Promise<void>;
  /** Fecha conexões/handles do banco. */
  close(): Promise<void>;
}

export interface OutboxRepo {
  enqueue(
    data: Omit<OutboxItem, 'id' | 'status' | 'error' | 'created_at' | 'sent_at'>,
  ): Promise<OutboxItem>;
  /**
   * CLAIM atômico de um lote pendente da instância: cada linha muda
   * pending→sending numa instrução condicional — dois workers nunca pegam o
   * mesmo item (mesmo padrão do claimDue dos fluxos).
   */
  claimPending(instanceId: string, limit: number): Promise<OutboxItem[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  listByInstance(instanceId: string, status?: string): Promise<OutboxItem[]>;
  /** Linka o item ao registro pré-logado em messages (feito pela mensageria). */
  setMessageId(id: string, messageId: string): Promise<void>;
}

export interface BaileysAuthRepo {
  get(instanceId: string, key: string): Promise<unknown | null>;
  set(instanceId: string, key: string, value: unknown): Promise<void>;
  delete(instanceId: string, key: string): Promise<void>;
  /** Todas as chaves da instância (restaurar sessão completa no boot). */
  listKeys(instanceId: string): Promise<string[]>;
  /** Limpa a sessão inteira (logout / re-parear). */
  clear(instanceId: string): Promise<void>;
}

export interface OrgsRepo {
  create(data: Omit<Org, 'id' | 'created_at'>): Promise<Org>;
  getById(id: string): Promise<Org | null>;
}

export interface UsersRepo {
  create(data: Omit<User, 'id' | 'created_at'>): Promise<User>;
  /** Login: email é único GLOBAL (resolve a org do usuário). */
  getByEmail(email: string): Promise<User | null>;
  getById(id: string): Promise<User | null>;
  listByOrg(orgId: string): Promise<User[]>;
  /** Total global de usuários — decide o modo bootstrap (V1 sem auth). */
  countAll(): Promise<number>;
}

export interface InstancesRepo {
  create(data: NewInstance): Promise<Instance>;
  getById(id: string): Promise<Instance | null>;
  /** [V2] com orgId: só instâncias daquela org. Sem orgId: todas (interno). */
  list(orgId?: string): Promise<Instance[]>;
  update(id: string, patch: Partial<NewInstance>): Promise<Instance | null>;
  delete(id: string): Promise<void>;
  /**
   * Resolve a instância pelo phone_number_id do payload do webhook.
   * Exceção justificada ao escopo por instance_id: é justamente como o
   * webhook descobre a instância.
   */
  getByPhoneNumberId(phoneNumberId: string): Promise<Instance | null>;
}

export interface MessagesRepo {
  create(data: NewMessage): Promise<Message>;
  getByWaMessageId(
    instanceId: string,
    waMessageId: string,
  ): Promise<Message | null>;
  updateStatusByWaMessageId(
    instanceId: string,
    waMessageId: string,
    patch: Pick<Message, 'status' | 'error_code' | 'error_message'>,
  ): Promise<void>;
  /** [V2] Worker confirma envio da outbox no registro pré-logado (queued). */
  updateById(
    id: string,
    patch: Partial<
      Pick<Message, 'status' | 'error_code' | 'error_message' | 'wa_message_id'>
    >,
  ): Promise<void>;
  listByContact(
    instanceId: string,
    phone: string,
    opts?: { limit?: number; before?: string },
  ): Promise<Message[]>;
  /** Resumo de conversas (Live Chat): última mensagem + não-lidas por contato. */
  listConversations(instanceId: string): Promise<ConversationSummary[]>;
}

export interface ContactsRepo {
  upsert(data: NewContact): Promise<Contact>;
  getById(instanceId: string, id: string): Promise<Contact | null>;
  getByPhone(instanceId: string, phone: string): Promise<Contact | null>;
  list(instanceId: string, opts?: { search?: string }): Promise<Contact[]>;
  touchLastSeen(instanceId: string, phone: string, at: string): Promise<void>;
  /** Marca a conversa como lida até `at` (Live Chat). */
  markRead(instanceId: string, phone: string, at: string): Promise<void>;
}

export interface TemplatesRepo {
  upsert(data: Omit<Template, 'id'>): Promise<Template>;
  list(instanceId: string): Promise<Template[]>;
  getById(instanceId: string, id: string): Promise<Template | null>;
  getByName(
    instanceId: string,
    name: string,
    language?: string,
  ): Promise<Template | null>;
}

export interface TagsRepo {
  create(data: Omit<Tag, 'id'>): Promise<Tag>;
  list(instanceId: string): Promise<Tag[]>;
  delete(instanceId: string, id: string): Promise<void>;
  applyToContacts(
    instanceId: string,
    tagId: string,
    contactIds: string[],
  ): Promise<void>;
  removeFromContacts(
    instanceId: string,
    tagId: string,
    contactIds: string[],
  ): Promise<void>;
  /** Tags aplicadas a um contato (usado pelo motor de fluxos e condições). */
  listForContact(instanceId: string, contactId: string): Promise<Tag[]>;
}

export interface CrmRepo {
  upsert(data: Omit<CrmContact, 'id'>): Promise<CrmContact>;
  getByContact(
    instanceId: string,
    contactId: string,
  ): Promise<CrmContact | null>;
  list(instanceId: string, opts?: { stage?: string }): Promise<CrmContact[]>;
}

export interface ListsRepo {
  create(data: Omit<ContactList, 'id'>): Promise<ContactList>;
  list(instanceId: string): Promise<ContactList[]>;
  delete(instanceId: string, id: string): Promise<void>;
  addContacts(
    instanceId: string,
    listId: string,
    contactIds: string[],
  ): Promise<void>;
  removeContacts(
    instanceId: string,
    listId: string,
    contactIds: string[],
  ): Promise<void>;
  listContacts(instanceId: string, listId: string): Promise<Contact[]>;
}

export interface CampaignsRepo {
  create(
    data: Omit<
      Campaign,
      'id' | 'sent_count' | 'failed_count' | 'created_at' | 'config'
    > & { config?: Campaign['config'] },
  ): Promise<Campaign>;
  getById(instanceId: string, id: string): Promise<Campaign | null>;
  list(instanceId: string): Promise<Campaign[]>;
  update(
    instanceId: string,
    id: string,
    patch: Partial<Campaign>,
  ): Promise<Campaign | null>;
  recordSend(data: Omit<CampaignSend, 'id'>): Promise<CampaignSend>;
  listSends(campaignId: string): Promise<CampaignSend[]>;
  /** Lote de envios pendentes (a fila do disparo retomável). */
  listPendingSends(campaignId: string, limit: number): Promise<CampaignSend[]>;
  /** Lista envios por status (auditoria — ex.: falhas com motivo). */
  listSendsByStatus(campaignId: string, status: string): Promise<CampaignSend[]>;
  updateSend(
    id: string,
    patch: Partial<
      Pick<
        CampaignSend,
        'status' | 'error_code' | 'error_message' | 'sent_at' | 'attempts'
      >
    >,
  ): Promise<void>;
  countSendsByStatus(
    campaignId: string,
  ): Promise<{ sent: number; failed: number; pending: number }>;
}

export interface FlowsRepo {
  create(data: Omit<Flow, 'id'>): Promise<Flow>;
  getById(instanceId: string, id: string): Promise<Flow | null>;
  list(instanceId: string): Promise<Flow[]>;
  update(
    instanceId: string,
    id: string,
    patch: Partial<Flow>,
  ): Promise<Flow | null>;
  findByTriggerKeyword(
    instanceId: string,
    keyword: string,
  ): Promise<Flow[]>;
}

export interface FlowExecutionsRepo {
  create(data: Omit<FlowExecution, 'id' | 'updated_at'>): Promise<FlowExecution>;
  getById(id: string): Promise<FlowExecution | null>;
  /** Execuções vencidas (next_step_at <= agora) prontas para retomar. */
  listDue(instanceId: string, now: string): Promise<FlowExecution[]>;
  /** Trava por (fluxo + contato) — lição nº 5. */
  findActiveByFlowAndContact(
    flowId: string,
    contactPhone: string,
  ): Promise<FlowExecution | null>;
  /** Execução aguardando resposta deste contato (roteamento de botões/listas). */
  findWaitingByContact(
    instanceId: string,
    contactPhone: string,
  ): Promise<FlowExecution | null>;
  /** Execuções ativas de um fluxo (aviso da lição 4 no builder). */
  listActiveByFlow(flowId: string): Promise<FlowExecution[]>;
  /**
   * Atualização condicional (trava otimista): só aplica se o status atual for
   * `expectedStatus`. Retorna o registro atualizado ou null se a condição
   * falhou — evita retomada em duplicidade sob concorrência.
   */
  updateIfStatus(
    id: string,
    expectedStatus: FlowExecution['status'],
    patch: Partial<FlowExecution>,
  ): Promise<FlowExecution | null>;
  /**
   * CLAIM atômico de retomada: numa ÚNICA instrução SQL condicional, zera o
   * next_step_at se (e só se) ele ainda estava vencido. Retorna a execução
   * reivindicada ou null se outro processo chegou antes. É o que garante que
   * processPendingExecutions nunca retoma a mesma execução duas vezes.
   */
  claimDue(id: string, nowIso: string): Promise<FlowExecution | null>;
  /**
   * Limpeza de execuções PRESAS (complemento da lição nº 5): cancela ativas
   * paradas há muito tempo (updated_at < cutoff) e SEM retomada agendada no
   * futuro. Retorna quantas foram canceladas (o chamador loga — não é
   * silencioso). Não toca em delays longos legítimos (next_step_at futuro).
   */
  cancelStuck(instanceId: string, cutoffIso: string): Promise<number>;
}

export interface MetricsRepo {
  /**
   * Métricas agregadas do dashboard (poucas queries GROUP BY, sem N+1).
   * [V2] orgId escopa os agregados cross-instância (ativas / por instância).
   */
  dashboard(instanceId: string, orgId?: string): Promise<DashboardMetrics>;
}

export interface FlowNodeCountersRepo {
  /**
   * Incremento atômico do contador round-robin do Randomizador (lição nº 3).
   * DEVE usar UMA única instrução SQL atômica (UPDATE ... RETURNING), nunca
   * ler→somar→salvar. Retorna o valor DEPOIS do incremento, módulo n.
   */
  incrementAndGet(flowId: string, nodeId: string, n: number): Promise<number>;
}
