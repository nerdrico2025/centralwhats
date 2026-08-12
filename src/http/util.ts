import type { NextFunction, Request, Response } from 'express';
import type { Repo } from '../repo';
import type { Instance } from '../repo/types';

/**
 * Envolve handlers async para que rejeições virem erros do Express (Express 4
 * não captura promises rejeitadas sozinho).
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

/** Contexto de autenticação da request (preenchido pelo authMiddleware). */
export interface AuthInfo {
  userId: string | null; // null no modo bootstrap (V1 sem usuários)
  orgId: string;
  role: 'owner' | 'agent';
}

/** Lê o AuthInfo anexado à request. Lança 401 se o middleware não rodou. */
export function getAuth(req: Request): AuthInfo {
  const auth = (req as Request & { auth?: AuthInfo }).auth;
  if (!auth) throw new HttpError(401, 'Não autenticado');
  return auth;
}

/** Middleware de papel: só owner passa (agent → 403). */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  const auth = (req as Request & { auth?: AuthInfo }).auth;
  if (!auth) {
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }
  if (auth.role !== 'owner') {
    res.status(403).json({ error: 'Apenas o dono da organização pode fazer isso' });
    return;
  }
  next();
}

/**
 * Carrega a instância do :id da rota ou lança 404. Todo escopo começa aqui.
 * Instância de OUTRA org retorna o MESMO 404 (não vaza que existe). Toda a
 * cadeia de dados (contacts, messages, flows, campaigns…) pende de
 * instance_id, então o isolamento cross-org é garantido neste gargalo único.
 *
 * `orgId` é OBRIGATÓRIO de propósito (P6.1): enquanto era opcional, esquecer o
 * argumento numa rota nova compilava, passava nos testes e vazava dados entre
 * contas em silêncio. Caminho de sistema (sem usuário) tem porta própria e
 * explícita: requireInstanceSystem().
 */
export async function requireInstance(
  repo: Repo,
  id: string,
  orgId: string,
): Promise<Instance> {
  const inst = await repo.instances.getById(id);
  if (!inst) throw new HttpError(404, 'Instância não encontrada');
  if (inst.org_id !== orgId) throw new HttpError(404, 'Instância não encontrada');
  return inst;
}

/**
 * Versão SEM escopo de org, para chamadores MÁQUINA-A-MÁQUINA (cron, worker
 * Baileys, webhook) — que autenticam por segredo/assinatura e não têm usuário
 * nem conta ativa. O nome é longo e explícito de propósito: usá-la a partir de
 * uma rota de usuário é um bug visível na revisão, não um descuido invisível.
 */
export async function requireInstanceSystem(repo: Repo, id: string): Promise<Instance> {
  const inst = await repo.instances.getById(id);
  if (!inst) throw new HttpError(404, 'Instância não encontrada');
  return inst;
}

/** Erro de aplicação com status HTTP e mensagem (em português) para o client. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Middleware final de erro: responde JSON padronizado, sem vazar stack. */
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details ?? null });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor' });
}
