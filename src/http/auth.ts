import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import { loadEnv } from '../config';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../util/auth';
import { asyncHandler, HttpError, type AuthInfo } from './util';

/**
 * Middleware de autenticação (V2 / P5.1).
 *
 * - Com Bearer token válido: anexa req.auth = { userId, orgId, role }.
 * - SEM token e SEM nenhum usuário cadastrado: MODO BOOTSTRAP — opera como
 *   owner da org default. É o que mantém a V1 (uso próprio) funcionando sem
 *   login; o primeiro registro de usuário tranca o sistema.
 * - Senão: 401.
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
        (req as Request & { auth?: AuthInfo }).auth = {
          userId: payload.sub,
          orgId: payload.org_id,
          role: payload.role,
        };
        next();
        return;
      }
      // Modo bootstrap: sem usuários no sistema, a V1 segue sem auth.
      if ((await repo.users.countAll()) === 0) {
        (req as Request & { auth?: AuthInfo }).auth = {
          userId: null,
          orgId: 'org_default',
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
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

function publicUser(u: { id: string; org_id: string; email: string; role: string }) {
  return { id: u.id, org_id: u.org_id, email: u.email, role: u.role };
}

/**
 * Rotas públicas de auth: POST /register (cria org + owner) e POST /login.
 * password_hash NUNCA sai na resposta.
 */
export function createAuthRouter(repo: Repo): Router {
  const router = Router();

  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      const d = parsed.data;

      if (await repo.users.getByEmail(d.email)) {
        throw new HttpError(409, 'E-mail já cadastrado');
      }
      const org = await repo.orgs.create({ name: d.org_name, plan: 'free' });
      const user = await repo.users.create({
        org_id: org.id,
        email: d.email,
        role: 'owner',
        password_hash: hashPassword(d.password),
      });
      const token = signToken(
        { sub: user.id, org_id: org.id, role: 'owner' },
        loadEnv().JWT_SECRET,
      );
      res.status(201).json({ token, user: publicUser(user), org });
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
      const token = signToken(
        { sub: user.id, org_id: user.org_id, role: user.role },
        loadEnv().JWT_SECRET,
      );
      res.json({ token, user: publicUser(user) });
    }),
  );

  return router;
}

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['owner', 'agent']).default('agent'),
});

/** Rotas de usuários da org (owner only — aplicado no app). */
export function createUsersRouter(repo: Repo): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = (req as Request & { auth?: AuthInfo }).auth!;
      const users = await repo.users.listByOrg(auth.orgId);
      res.json(users.map(publicUser));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const auth = (req as Request & { auth?: AuthInfo }).auth!;
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      if (await repo.users.getByEmail(parsed.data.email)) {
        throw new HttpError(409, 'E-mail já cadastrado');
      }
      const user = await repo.users.create({
        org_id: auth.orgId, // sempre a org do owner — nunca cross-org
        email: parsed.data.email,
        role: parsed.data.role,
        password_hash: hashPassword(parsed.data.password),
      });
      res.status(201).json(publicUser(user));
    }),
  );

  return router;
}
