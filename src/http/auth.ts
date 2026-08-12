import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import type { User, UserRole } from '../repo/types';
import { loadEnv } from '../config';
import {
  hashInviteToken,
  hashPassword,
  signToken,
  verifyPassword,
  verifyToken,
} from '../util/auth';
import { asyncHandler, HttpError, type AuthInfo } from './util';

/** Org semeada pela migration 006 — destino das instâncias da V1. */
export const DEFAULT_ORG_ID = 'org_default';

/**
 * Middleware de autenticação (P6.1).
 *
 * O que mudou em relação à V2 inicial: o `org_id` do token deixou de ser
 * confiável por si só. Com vínculo N:N (modelo agência), um token continua
 * válido enquanto não expira — mas a pessoa pode ter sido removida da conta,
 * desabilitada, ou ter trocado a senha desde então. Por isso, a cada request:
 *
 *   1. o usuário do `sub` ainda existe e está `active`;
 *   2. o token foi emitido DEPOIS da última troca de senha (revogação);
 *   3. o usuário É MEMBRO da org que o token diz ser a ativa — e o papel
 *      efetivo vem de `org_members`, não do que está escrito no token.
 *
 * Custo: uma leitura de `users` + uma de `org_members`. O modo bootstrap já
 * lia `users` em toda request, então o acréscimo é de uma consulta indexada
 * por chave primária.
 *
 * MODO BOOTSTRAP (inalterado): sem NENHUM usuário cadastrado, opera como owner
 * da org default. É o que mantém a V1 funcionando sem login; o primeiro
 * registro tranca o sistema.
 */
export function createAuthMiddleware(repo: Repo) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        const payload = verifyToken(header.slice(7), loadEnv().JWT_SECRET);
        if (!payload) {
          res.status(401).json({ error: 'Token inválido ou expirado' });
          return;
        }

        const user = await repo.users.getById(payload.sub);
        if (!user) {
          res.status(401).json({ error: 'Sessão inválida' });
          return;
        }
        if (user.status !== 'active') {
          res.status(401).json({ error: 'Usuário desabilitado' });
          return;
        }
        if ((payload.pwd ?? null) !== (user.password_changed_at ?? null)) {
          res.status(401).json({ error: 'Sessão encerrada (a senha foi alterada)' });
          return;
        }

        // Fonte da verdade do acesso E do papel: o vínculo, não o token.
        const role = await repo.orgMembers.getRole(payload.org_id, user.id);
        if (!role) {
          res.status(403).json({ error: 'Você não tem acesso a esta conta' });
          return;
        }

        (req as Request & { auth?: AuthInfo }).auth = {
          userId: user.id,
          orgId: payload.org_id,
          role,
        };
        next();
        return;
      }

      // Modo bootstrap: sem usuários no sistema, a V1 segue sem auth.
      if ((await repo.users.countAll()) === 0) {
        (req as Request & { auth?: AuthInfo }).auth = {
          userId: null,
          orgId: DEFAULT_ORG_ID,
          role: 'owner',
        };
        next();
        return;
      }
      res.status(401).json({ error: 'Não autenticado' });
    })().catch(next);
  };
}

const registerSchema = z.object({
  org_name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8, 'Senha deve ter no mínimo 8 caracteres'),
  name: z.string().min(1).optional(),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export function publicUser(u: {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  status?: string;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name ?? null,
    role: u.role,
    status: u.status ?? 'active',
  };
}

/**
 * Resolve a org ATIVA de um login: a org de entrada gravada em `users.org_id`
 * (cache) se o vínculo ainda existir, senão a primeira org da qual o usuário é
 * membro. Devolve null se o usuário não é membro de nenhuma conta — situação
 * possível (removido de todas) e que deve virar 403 explícito, nunca acesso a
 * uma org qualquer.
 */
async function resolveActiveOrg(
  repo: Repo,
  user: User,
): Promise<{ orgId: string; role: UserRole } | null> {
  const memberships = await repo.orgMembers.listByUser(user.id);
  if (memberships.length === 0) return null;
  const preferred = memberships.find((mem) => mem.org_id === user.org_id) ?? memberships[0];
  return { orgId: preferred.org_id, role: preferred.role };
}

/**
 * Rotas PÚBLICAS de auth (montadas antes do middleware): registro, login,
 * status do registro e o fluxo de aceite de convite.
 */
export function createAuthRouter(repo: Repo): Router {
  const router = Router();

  /**
   * Estado do registro — a tela de login usa para decidir se mostra "criar
   * organização". Não exige auth e não vaza nada além do que a própria
   * tentativa de registro já revelaria.
   */
  router.get(
    '/registration-status',
    asyncHandler(async (_req, res) => {
      const bootstrap = (await repo.users.countAll()) === 0;
      res.json({ bootstrap, public_signup: loadEnv().PUBLIC_SIGNUP, open: bootstrap || loadEnv().PUBLIC_SIGNUP });
    }),
  );

  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      const d = parsed.data;

      const isBootstrap = (await repo.users.countAll()) === 0;

      // FAIL-CLOSED (B2): fora do bootstrap, registro público só existe com a
      // variável ligada. No modelo agência o caminho normal é CONVITE.
      if (!isBootstrap && !loadEnv().PUBLIC_SIGNUP) {
        throw new HttpError(
          403,
          'Registro público desabilitado. Peça um convite ao administrador da conta.',
        );
      }

      if (await repo.users.getByEmail(d.email)) {
        throw new HttpError(409, 'E-mail já cadastrado');
      }

      // === B1: o primeiro registro ADOTA a org default ===
      // Sem isto, o primeiro owner nasceria numa org NOVA e a instância de
      // produção (que vive em org_default desde a migration 006) ficaria sem
      // dono nenhum: invisível no painel, mas ainda recebendo webhook. Perda
      // de acesso silenciosa — exatamente o que este ramo evita.
      const defaultOrg = isBootstrap ? await repo.orgs.getById(DEFAULT_ORG_ID) : null;
      const adopt = defaultOrg != null && (await repo.orgs.countInstances(DEFAULT_ORG_ID)) > 0;

      const org = adopt
        ? ((await repo.orgs.rename(DEFAULT_ORG_ID, d.org_name)) ?? defaultOrg!)
        : await repo.orgs.create({ name: d.org_name, plan: 'free' });

      const user = await repo.users.create({
        org_id: org.id,
        email: d.email,
        name: d.name ?? null,
        role: 'owner',
        password_hash: hashPassword(d.password),
      });
      await repo.orgMembers.add(org.id, user.id, 'owner');

      const token = signToken(
        { sub: user.id, org_id: org.id, role: 'owner', pwd: user.password_changed_at },
        loadEnv().JWT_SECRET,
      );
      res.status(201).json({
        token,
        user: publicUser(user),
        org,
        // Diagnóstico honesto para o painel e para os logs de deploy: diz se
        // esta conta herdou as instâncias que já existiam.
        adopted_default_org: adopt,
      });
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      const user = await repo.users.getByEmail(parsed.data.email);
      // Mesma mensagem para email inexistente e senha errada (não vaza qual).
      if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
        throw new HttpError(401, 'E-mail ou senha inválidos');
      }
      if (user.status !== 'active') {
        throw new HttpError(403, 'Usuário desabilitado. Fale com o administrador da conta.');
      }

      const active = await resolveActiveOrg(repo, user);
      if (!active) {
        throw new HttpError(403, 'Seu usuário não está vinculado a nenhuma conta.');
      }

      await repo.users.markLogin(user.id, new Date().toISOString(), active.orgId);
      const token = signToken(
        {
          sub: user.id,
          org_id: active.orgId,
          role: active.role,
          pwd: user.password_changed_at,
        },
        loadEnv().JWT_SECRET,
      );
      res.json({
        token,
        user: { ...publicUser(user), role: active.role },
        active_org_id: active.orgId,
      });
    }),
  );

  // ------------------------------------------------------------- convites
  /**
   * Prévia do convite (rota pública, como /login): a tela de aceite precisa
   * saber para qual conta é, com qual papel, e se o e-mail JÁ TEM conta — o
   * que muda o formulário de "defina sua senha" para "confirme sua senha".
   */
  router.get(
    '/invite/:token',
    asyncHandler(async (req, res) => {
      const invite = await repo.invites.getByTokenHash(hashInviteToken(req.params.token));
      const state = inviteState(invite, new Date());
      if (state !== 'valid') {
        throw new HttpError(404, inviteErrorMessage(state));
      }
      const org = await repo.orgs.getById(invite!.org_id);
      const existing = await repo.users.getByEmail(invite!.email);
      res.json({
        org_name: org?.name ?? 'conta',
        email: invite!.email,
        role: invite!.role,
        expires_at: invite!.expires_at,
        has_account: existing != null,
      });
    }),
  );

  const acceptSchema = z.object({
    token: z.string().min(10),
    password: z.string().min(8, 'Senha deve ter no mínimo 8 caracteres'),
    name: z.string().min(1).optional(),
  });

  /**
   * Aceite do convite. Cria o vínculo em org_members (e o usuário, se o e-mail
   * ainda não tiver conta) consumindo o token na MESMA operação.
   *
   * SEGURANÇA (e-mail que já tem conta): a senha enviada precisa ser a senha
   * ATUAL daquele usuário. Sem essa exigência, qualquer owner poderia convidar
   * o e-mail de um usuário existente, aceitar o próprio convite com uma senha
   * nova e tomar a conta alheia — o convite viraria um "esqueci a senha" sem
   * verificação de e-mail.
   *
   * O PAPEL vem sempre do convite, nunca do corpo da requisição.
   */
  router.post(
    '/invite/accept',
    asyncHandler(async (req, res) => {
      const parsed = acceptSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      const { token, password, name } = parsed.data;

      const invite = await repo.invites.getByTokenHash(hashInviteToken(token));
      const state = inviteState(invite, new Date());
      if (state !== 'valid') throw new HttpError(404, inviteErrorMessage(state));

      const existing = await repo.users.getByEmail(invite!.email);
      if (existing) {
        if (!verifyPassword(password, existing.password_hash)) {
          throw new HttpError(
            401,
            'Este e-mail já tem conta. Informe a SENHA ATUAL dela para aceitar o convite.',
          );
        }
        if (existing.status !== 'active') {
          throw new HttpError(403, 'Usuário desabilitado. Fale com o administrador.');
        }
      }

      const user =
        existing ??
        (await repo.users.create({
          org_id: invite!.org_id,
          email: invite!.email,
          name: name ?? null,
          role: invite!.role,
          password_hash: hashPassword(password),
        }));

      // Uso único: só quem vence esta instrução condicional cria o vínculo.
      const consumed = await repo.invites.markAcceptedIfPending(
        invite!.id,
        user.id,
        new Date().toISOString(),
      );
      if (!consumed) {
        throw new HttpError(409, 'Este convite já foi utilizado.');
      }
      await repo.orgMembers.add(invite!.org_id, user.id, invite!.role);

      const jwt = signToken(
        {
          sub: user.id,
          org_id: invite!.org_id,
          role: invite!.role,
          pwd: user.password_changed_at,
        },
        loadEnv().JWT_SECRET,
      );
      res.status(201).json({
        token: jwt,
        user: { ...publicUser(user), role: invite!.role },
        active_org_id: invite!.org_id,
      });
    }),
  );

  return router;
}

type InviteState = 'valid' | 'not_found' | 'used' | 'revoked' | 'expired';

/** Estado efetivo do convite (expiração é derivada, não gravada). */
export function inviteState(
  invite: { status: string; expires_at: string } | null,
  now: Date,
): InviteState {
  if (!invite) return 'not_found';
  if (invite.status === 'accepted') return 'used';
  if (invite.status === 'revoked') return 'revoked';
  if (new Date(invite.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'valid';
}

function inviteErrorMessage(state: InviteState): string {
  switch (state) {
    case 'used':
      return 'Este convite já foi utilizado.';
    case 'revoked':
      return 'Este convite foi cancelado.';
    case 'expired':
      return 'Este convite expirou. Peça um novo ao administrador.';
    default:
      return 'Convite não encontrado.';
  }
}
