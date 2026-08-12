import { Router } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import type { Invite } from '../repo/types';
import { loadEnv } from '../config';
import { hashPassword, newInviteToken, signToken, verifyPassword } from '../util/auth';
import { asyncHandler, getAuth, HttpError } from './util';
import { inviteState, publicUser } from './auth';

/** Validade padrão do convite: 72h (o suficiente para o convidado agir). */
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Rotas de SESSÃO (P6.1) — quem sou eu, em qual conta estou, e como troco.
 *
 * No modelo agência o mesmo usuário administra várias contas de cliente, então
 * "a org do usuário" deixou de ser um valor único: o token carrega a org ATIVA
 * e estas rotas são o que permite trocá-la.
 */
export function createSessionRouter(repo: Repo): Router {
  const router = Router();

  // GET /api/me — usuário, conta ativa e a lista de contas às quais ele tem
  // acesso (é o que popula o seletor no topo do painel).
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);

      // Modo bootstrap: não há usuário nenhum: a sessão é a org default.
      if (!auth.userId) {
        const org = await repo.orgs.getById(auth.orgId);
        res.json({
          bootstrap: true,
          user: null,
          active_org_id: auth.orgId,
          role: auth.role,
          orgs: org ? [{ org_id: org.id, org_name: org.name, role: 'owner' }] : [],
        });
        return;
      }

      const user = await repo.users.getById(auth.userId);
      if (!user) throw new HttpError(401, 'Sessão inválida');
      res.json({
        bootstrap: false,
        user: { ...publicUser(user), role: auth.role },
        active_org_id: auth.orgId,
        role: auth.role,
        orgs: await repo.orgMembers.listByUser(user.id),
      });
    }),
  );

  // POST /api/me/switch-org — reemite o JWT com outra org ativa.
  // A troca só vale se o vínculo existir: o corpo da requisição pede, o banco
  // decide (mesmo princípio do middleware).
  router.post(
    '/switch-org',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      if (!auth.userId) {
        throw new HttpError(400, 'Modo inicial (sem usuários): não há contas para alternar.');
      }
      const parsed = z.object({ org_id: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);

      const role = await repo.orgMembers.getRole(parsed.data.org_id, auth.userId);
      if (!role) throw new HttpError(403, 'Você não tem acesso a esta conta');
      const user = await repo.users.getById(auth.userId);
      if (!user) throw new HttpError(401, 'Sessão inválida');

      // Cache da org de entrada: o próximo login já cai na conta certa.
      await repo.users.markLogin(auth.userId, new Date().toISOString(), parsed.data.org_id);
      const org = await repo.orgs.getById(parsed.data.org_id);
      res.json({
        token: signToken(
          {
            sub: auth.userId,
            org_id: parsed.data.org_id,
            role,
            pwd: user.password_changed_at,
          },
          loadEnv().JWT_SECRET,
        ),
        active_org_id: parsed.data.org_id,
        org_name: org?.name ?? null,
        role,
      });
    }),
  );

  // POST /api/me/password — troca a própria senha.
  // Carimba password_changed_at, o que INVALIDA todas as sessões anteriores
  // (o middleware compara o carimbo do token com o do banco).
  router.post(
    '/password',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      if (!auth.userId) {
        throw new HttpError(400, 'Modo inicial (sem usuários): não há senha para trocar.');
      }
      const parsed = z
        .object({
          current_password: z.string().min(1),
          new_password: z.string().min(8, 'Senha deve ter no mínimo 8 caracteres'),
        })
        .safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);

      const user = await repo.users.getById(auth.userId);
      if (!user) throw new HttpError(401, 'Sessão inválida');
      if (!verifyPassword(parsed.data.current_password, user.password_hash)) {
        throw new HttpError(401, 'Senha atual incorreta');
      }

      // O novo carimbo entra no token devolvido: quem trocou a senha segue
      // logado NESTE dispositivo, e só nele — todo token anterior carrega o
      // carimbo antigo e é recusado na request seguinte.
      const changedAt = new Date().toISOString();
      await repo.users.setPassword(user.id, hashPassword(parsed.data.new_password), changedAt);
      res.json({
        token: signToken(
          { sub: user.id, org_id: auth.orgId, role: auth.role, pwd: changedAt },
          loadEnv().JWT_SECRET,
        ),
        sessions_revoked: true,
      });
    }),
  );

  return router;
}

/**
 * Rotas de EQUIPE da conta ativa (owner only — aplicado no app).
 *
 * A criação de usuário com senha escolhida pelo owner FOI REMOVIDA: o owner
 * conhecia a senha do agente, o que arruína qualquer não-repúdio. Entrada de
 * gente nova agora é só por convite (createInvitesRouter).
 */
export function createUsersRouter(repo: Repo): Router {
  const router = Router();

  // GET /api/users — equipe da conta ATIVA (via org_members, não users.org_id).
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      res.json(await repo.orgMembers.listByOrg(auth.orgId));
    }),
  );

  /** Alvo precisa ser membro da conta ativa — senão 404 (não vaza existência). */
  async function requireMember(repo: Repo, orgId: string, userId: string): Promise<void> {
    const role = await repo.orgMembers.getRole(orgId, userId);
    if (!role) throw new HttpError(404, 'Usuário não encontrado nesta conta');
  }

  // POST /api/users/:id/disable — derruba as sessões na request seguinte.
  router.post(
    '/:id/disable',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      // Trava anti-lockout: desabilitar a si mesmo deixaria a conta sem
      // ninguém capaz de reabilitar (só owner pode, e ele acabou de sair).
      if (auth.userId && auth.userId === req.params.id) {
        throw new HttpError(400, 'Você não pode desabilitar o próprio usuário');
      }
      await requireMember(repo, auth.orgId, req.params.id);
      await repo.users.setStatus(req.params.id, 'disabled');
      res.json({ id: req.params.id, status: 'disabled' });
    }),
  );

  router.post(
    '/:id/enable',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      await requireMember(repo, auth.orgId, req.params.id);
      await repo.users.setStatus(req.params.id, 'active');
      res.json({ id: req.params.id, status: 'active' });
    }),
  );

  return router;
}

/** Forma pública do convite: NUNCA devolve o token_hash. */
function publicInvite(inv: Invite, now: Date) {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    // Estado EFETIVO (expirado é derivado de expires_at, não gravado).
    state: inviteState(inv, now),
    expires_at: inv.expires_at,
    created_at: inv.created_at,
    accepted_at: inv.accepted_at,
  };
}

/**
 * Convites (owner only). O token em claro só aparece UMA vez, na resposta de
 * criação/reenvio — o banco guarda apenas o SHA-256.
 *
 * O link volta como caminho relativo (`/convite/<token>`) de propósito: montar
 * a URL absoluta a partir do header Host confiaria num valor que o cliente
 * controla. Quem monta é o frontend, com o próprio `location.origin`.
 */
export function createInvitesRouter(repo: Repo): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const now = new Date();
      const invites = await repo.invites.listByOrg(auth.orgId);
      res.json(invites.map((inv) => publicInvite(inv, now)));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const parsed = z
        .object({
          email: z.string().email(),
          role: z.enum(['owner', 'agent']).default('agent'),
        })
        .safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);

      const email = parsed.data.email.trim().toLowerCase();
      // Já é membro? Convidar de novo não faria nada além de confundir.
      const existing = await repo.users.getByEmail(email);
      if (existing && (await repo.orgMembers.getRole(auth.orgId, existing.id))) {
        throw new HttpError(409, 'Este e-mail já faz parte desta conta');
      }

      const { token, hash } = newInviteToken();
      const invite = await repo.invites.create({
        org_id: auth.orgId,
        email,
        role: parsed.data.role,
        token_hash: hash,
        expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        created_by: auth.userId,
      });
      res.status(201).json({
        ...publicInvite(invite, new Date()),
        token,
        path: `/convite/${token}`,
      });
    }),
  );

  // Reenviar = novo token + nova validade. O link antigo para de funcionar.
  router.post(
    '/:id/resend',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const invite = await repo.invites.getById(auth.orgId, req.params.id);
      if (!invite) throw new HttpError(404, 'Convite não encontrado');
      if (invite.status === 'accepted') {
        throw new HttpError(409, 'Este convite já foi aceito');
      }
      const { token, hash } = newInviteToken();
      const ok = await repo.invites.refreshToken(
        auth.orgId,
        invite.id,
        hash,
        new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      );
      if (!ok) throw new HttpError(409, 'Não foi possível reenviar este convite');
      const updated = await repo.invites.getById(auth.orgId, invite.id);
      res.json({ ...publicInvite(updated!, new Date()), token, path: `/convite/${token}` });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const ok = await repo.invites.revoke(auth.orgId, req.params.id);
      // 404 quando não havia convite PENDENTE com esse id nesta conta — o
      // chamador precisa saber que nada foi cancelado (nunca fingir sucesso).
      if (!ok) throw new HttpError(404, 'Convite pendente não encontrado');
      res.sendStatus(204);
    }),
  );

  return router;
}
