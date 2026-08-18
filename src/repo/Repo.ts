import type {
  ApiKey,
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
  Invite,
  Message,
  NewContact,
  NewInstance,
  NewMessage,
  Org,
  OrgMember,
  OrgMembership,
  OrgMemberView,
  OutboxItem,
  Tag,
  Template,
  User,
  UserRole,
  UserStatus,
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
  orgMembers: OrgMembersRepo; // [P6.1]
  invites: InvitesRepo; // [P6.1]
  apiKeys: ApiKeysRepo; // [P6.3] chaves de serviço (máquina-a-máquina)
  outbox: OutboxRepo; // [V2]
  baileysAuth: BaileysAuthRepo; // [V2]
  maintenance: MaintenanceRepo; // [P6.1]

  /** Roda as migrations pendentes para o driver ativo. */
  migrate(): Promise<void>;
  /** Fecha conexões/handles do banco. */
  close(): Promise<void>;
}

/** Tarefas de manutenção que precisam olhar a forma CRUA do dado gravado. */
export interface MaintenanceRepo {
  /**
   * Backfill de criptografia (P6.1 / L1): cifra os segredos que ainda estão em
   * texto claro. IDEMPOTENTE — linha já cifrada é contada em `skipped` e não é
   * tocada, então rodar duas vezes não gera cifra sobre cifra.
   *
   * Vive no adapter porque precisa ler o valor ANTES da camada transparente de
   * decifragem — é o único lugar do sistema que enxerga o formato armazenado.
   */
  backfillSecretEncryption(): Promise<{
    instanceTokens: number;
    instanceVerifyTokens: number;
    baileysAuthValues: number;
    skipped: number;
  }>;
  /** Instâncias sem org ou com org inexistente — auditoria pré-migration 012. */
  findOrphanInstances(): Promise<{ id: string; name: string; org_id: string | null }[]>;
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
  /**
   * Devolve um item claimed à fila (sending→pending) — erro TRANSITÓRIO, que
   * melhora tentando de novo. Guarda o motivo da tentativa que falhou, para o
   * item não voltar à fila sem explicação. O limite de repetição NÃO mora aqui:
   * quem chama decide (ver failStaleOutbox / OUTBOX_STALE_MINUTES).
   */
  requeue(id: string, error: string): Promise<void>;
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
  /** Renomeia a org (usado quando o primeiro owner adota a org default). */
  rename(id: string, name: string): Promise<Org | null>;
  /** Quantas instâncias pertencem à org — decide a adoção da org default. */
  countInstances(id: string): Promise<number>;
}

export interface UsersRepo {
  create(
    data: Omit<
      User,
      'id' | 'created_at' | 'status' | 'password_changed_at' | 'last_login_at' | 'name'
    > & { name?: string | null; status?: UserStatus },
  ): Promise<User>;
  /** Login: email é único GLOBAL (resolve o usuário, não a org). */
  getByEmail(email: string): Promise<User | null>;
  getById(id: string): Promise<User | null>;
  /**
   * @deprecated Lê `users.org_id`, que é cache. Para a equipe de uma conta use
   * `repo.orgMembers.listByOrg()`.
   */
  listByOrg(orgId: string): Promise<User[]>;
  /** Total global de usuários — decide o modo bootstrap (V1 sem auth). */
  countAll(): Promise<number>;
  /** Troca a senha e carimba password_changed_at (derruba as sessões). */
  setPassword(id: string, passwordHash: string, changedAt: string): Promise<void>;
  /** Ativa/desativa. 'disabled' derruba as sessões na request seguinte. */
  setStatus(id: string, status: UserStatus): Promise<void>;
  /** Marca o login e a org de entrada (cache) — nunca decide acesso. */
  markLogin(id: string, at: string, activeOrgId: string): Promise<void>;
}

/** Vínculo N:N usuário↔org. Fonte da verdade do acesso e do papel [P6.1]. */
export interface OrgMembersRepo {
  add(orgId: string, userId: string, role: UserRole): Promise<OrgMember>;
  /**
   * Papel do usuário NAQUELA org, ou null se não é membro. É o que o
   * middleware de auth consulta a cada request — o `org_id` do JWT sozinho
   * nunca autoriza nada.
   */
  getRole(orgId: string, userId: string): Promise<UserRole | null>;
  /** Orgs do usuário (com nome e papel) — alimenta o seletor de conta. */
  listByUser(userId: string): Promise<OrgMembership[]>;
  /** Equipe da org (com dados do usuário). */
  listByOrg(orgId: string): Promise<OrgMemberView[]>;
  remove(orgId: string, userId: string): Promise<void>;
}

export interface InvitesRepo {
  create(
    data: Omit<Invite, 'id' | 'status' | 'created_at' | 'accepted_at' | 'accepted_user_id'>,
  ): Promise<Invite>;
  getByTokenHash(tokenHash: string): Promise<Invite | null>;
  getById(orgId: string, id: string): Promise<Invite | null>;
  listByOrg(orgId: string): Promise<Invite[]>;
  /**
   * Consome o convite ATOMICAMENTE: só marca 'accepted' se ainda estiver
   * 'pending'. Retorna false se outro aceite chegou antes — é o que garante o
   * uso único do token (CLAUDE.md §contadores atômicos).
   */
  markAcceptedIfPending(id: string, userId: string, at: string): Promise<boolean>;
  revoke(orgId: string, id: string): Promise<boolean>;
  /** Novo token/validade para o mesmo convite (reenviar link). */
  refreshToken(orgId: string, id: string, tokenHash: string, expiresAt: string): Promise<boolean>;
}

/**
 * Chaves de API de serviço [P6.3]. O escopo por org é do DADO, não da query:
 * toda chave nasce com `org_id`, e a autenticação devolve esse org_id ao
 * `requireInstance` — que já é o gargalo único de isolamento do sistema.
 */
export interface ApiKeysRepo {
  create(
    data: Omit<ApiKey, 'id' | 'created_at' | 'revoked_at' | 'last_used_at'>,
  ): Promise<ApiKey>;
  /**
   * Busca pelo hash — o único caminho de autenticação. Devolve a chave mesmo
   * REVOGADA: quem decide é o middleware, que precisa distinguir "não existe"
   * de "existia e foi revogada" para o log (sem contar isso ao cliente).
   */
  getByKeyHash(keyHash: string): Promise<ApiKey | null>;
  listByOrg(orgId: string): Promise<ApiKey[]>;
  /** Soft revoke. `false` se não existia nesta org ou já estava revogada. */
  revoke(orgId: string, id: string, at: string): Promise<boolean>;
  /** Carimbo de uso; chamado fora do caminho da resposta (nunca bloqueia). */
  touchLastUsed(id: string, at: string): Promise<void>;
}

export interface InstancesRepo {
  create(data: NewInstance): Promise<Instance>;
  getById(id: string): Promise<Instance | null>;
  /**
   * Instâncias de UMA org. O escopo é obrigatório: quem precisa varrer tudo
   * usa `listAll()` e assume explicitamente que é caminho de sistema.
   */
  list(orgId: string): Promise<Instance[]>;
  /**
   * TODAS as instâncias, sem escopo de org. Só para caminhos MÁQUINA-A-MÁQUINA
   * (cron, worker Baileys, verificação do webhook), que não têm usuário nem org
   * ativa. Nunca use a partir de uma rota de usuário.
   */
  listAll(): Promise<Instance[]>;
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
  /** Leitura por id — usada para reaproveitar o wa_message_id já reservado. */
  getById(id: string): Promise<Message | null>;
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
  /**
   * Escreve o nome DIRETO (edição do operador), sem a semântica de merge do
   * upsert — que é do caminho do webhook. Passar `null` limpa o nome e devolve
   * o controle à Meta; com 'manual', o profile.name para de sobrescrever.
   * Devolve null se o contato não é da instância (escopo).
   */
  setName(
    instanceId: string,
    contactId: string,
    name: string | null,
    source: 'manual' | 'profile',
  ): Promise<Contact | null>;
  /**
   * Grava a foto de perfil E o carimbo da tentativa. `url` null com `fetchedAt`
   * preenchido é o CACHE NEGATIVO: contato sem foto (ou que a esconde) não pode
   * virar uma chamada de rede por mensagem, para sempre.
   */
  setAvatar(
    instanceId: string,
    phone: string,
    url: string | null,
    fetchedAt: string,
  ): Promise<void>;
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
  /**
   * Todas as tags da instância agrupadas por contato, em UMA query. É o que
   * deixa a lista de contatos mostrar as tags sem disparar um request por
   * linha (N+1) a partir do browser. Contatos sem tag simplesmente não
   * aparecem no mapa.
   */
  listGroupedByContact(instanceId: string): Promise<Record<string, Tag[]>>;
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
  /**
   * Remove a campanha e, por ON DELETE CASCADE, suas linhas em campaign_sends.
   * Escopada por instance_id: campanha de outra instância não é encontrada nem
   * apagada. Devolve `false` quando nada foi removido, para a rota responder
   * 404 em vez de fingir sucesso (CLAUDE.md §nunca falhar em silêncio).
   */
  delete(instanceId: string, id: string): Promise<boolean>;
  recordSend(data: Omit<CampaignSend, 'id'>): Promise<CampaignSend>;
  listSends(campaignId: string): Promise<CampaignSend[]>;
  /** Lote de envios pendentes (a fila do disparo retomável). */
  listPendingSends(campaignId: string, limit: number): Promise<CampaignSend[]>;
  /**
   * Reivindica ATOMICAMENTE um lote de pendentes (pending → sending) e devolve
   * as linhas travadas. É UMA instrução SQL (CLAUDE.md §contadores atômicos):
   * dois ticks concorrentes — polling da UI + retomada por webhook — nunca
   * pegam o mesmo destinatário, senão o contato receberia a mensagem 2x.
   */
  claimPendingSends(
    campaignId: string,
    limit: number,
    claimedAt: string,
  ): Promise<CampaignSend[]>;
  /**
   * Devolve à fila envios travados em 'sending' antes de `olderThan` (tick que
   * morreu no meio). Sem isso a campanha ficaria pendurada para sempre.
   */
  reclaimStaleSends(campaignId: string, olderThan: string): Promise<number>;
  /** Lista envios por status (auditoria — ex.: falhas com motivo). */
  listSendsByStatus(campaignId: string, status: string): Promise<CampaignSend[]>;
  updateSend(
    id: string,
    patch: Partial<
      Pick<
        CampaignSend,
        | 'status'
        | 'error_code'
        | 'error_message'
        | 'sent_at'
        | 'attempts'
        | 'wa_message_id'
        | 'claimed_at'
      >
    >,
  ): Promise<void>;
  /**
   * A Meta aceita o envio (200 + wamid) e só depois reporta a falha real via
   * webhook de status. Sem isto, campaign_sends ficaria 'sent' para sempre e a
   * campanha diria "3 enviados" com 2 nunca entregues. Devolve o campaign_id
   * afetado (null se o wamid não é de campanha), para recalcular contadores.
   */
  markSendFailedByWaMessageId(
    instanceId: string,
    waMessageId: string,
    errorCode: string | null,
    errorMessage: string | null,
  ): Promise<string | null>;
  /** `pending` inclui os 'sending' em voo — são trabalho ainda não concluído. */
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
