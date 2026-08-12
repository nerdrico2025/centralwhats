import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import type { Repo } from '../repo';
import type { Instance } from '../repo/types';
import { asyncHandler, getAuth, HttpError, requireInstance } from './util';

/**
 * Mascara um segredo para exibição. NUNCA retorna o valor em texto claro
 * (CLAUDE.md: segredos nunca no client). Mostra só os últimos 4 caracteres
 * para o operador conseguir identificar qual credencial está configurada.
 */
function maskSecret(v: string | null): string | null {
  if (!v) return null;
  return v.length > 4 ? `••••${v.slice(-4)}` : '••••';
}

/** Forma pública da instância, com token/verify_token mascarados. */
export function maskInstance(i: Instance) {
  return {
    id: i.id,
    name: i.name,
    provider_type: i.provider_type,
    phone_number_id: i.phone_number_id,
    waba_id: i.waba_id,
    active: i.active,
    connection_status: i.connection_status,
    created_at: i.created_at ?? null,
    // Segredos mascarados + flags de presença (para a UI saber se estão setados).
    token: maskSecret(i.token),
    verify_token: maskSecret(i.verify_token),
    has_token: !!i.token,
    has_verify_token: !!i.verify_token,
    // Credenciais gravadas que não decifram com a chave atual. A UI avisa e
    // oferece o recadastro — em vez de o operador ver a instância "sem token"
    // e não entender por quê.
    secrets_unreadable: i.secrets_unreadable === true,
  };
}

const providerTypeSchema = z.enum(['meta', 'baileys']);
const connectionStatusSchema = z.enum(['connected', 'disconnected', 'pending']);

const createSchema = z.object({
  name: z.string().min(1, 'name é obrigatório'),
  provider_type: providerTypeSchema.default('meta'),
  phone_number_id: z.string().min(1).nullish(),
  waba_id: z.string().min(1).nullish(),
  token: z.string().min(1).nullish(),
  verify_token: z.string().min(1).nullish(),
  active: z.boolean().default(true),
  connection_status: connectionStatusSchema.default('disconnected'),
});

const updateSchema = z
  .object({
    name: z.string().min(1),
    provider_type: providerTypeSchema,
    phone_number_id: z.string().min(1).nullable(),
    waba_id: z.string().min(1).nullable(),
    token: z.string().min(1).nullable(),
    verify_token: z.string().min(1).nullable(),
    active: z.boolean(),
    connection_status: connectionStatusSchema,
  })
  .partial();

/** undefined → null, para casar com o tipo NewInstance (campos `| null`). */
function orNull<T>(v: T | null | undefined): T | null {
  return v ?? null;
}

/**
 * Rotas REST de Instâncias. Todo acesso a dados passa por repo.instances.
 * Respostas sempre mascaram os segredos via maskInstance().
 */
export function createInstancesRouter(repo: Repo): Router {
  const router = Router();

  // GET /instances — lista SÓ da org do usuário (agent e owner).
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const list = await repo.instances.list(auth.orgId);
      res.json(list.map(maskInstance));
    }),
  );

  // GET /instances/:id — 404 se for de outra org.
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const inst = await requireInstance(repo, req.params.id, auth.orgId);
      res.json(maskInstance(inst));
    }),
  );

  // GET /instances/:id/qr — QR de pareamento Baileys (gerado pelo worker).
  router.get(
    '/:id/qr',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const inst = await requireInstance(repo, req.params.id, auth.orgId);
      if (inst.provider_type !== 'baileys') {
        throw new HttpError(400, 'QR code só existe para instâncias Baileys');
      }
      const qr = await repo.baileysAuth.get(inst.id, 'qr');
      res.json({ qr: qr != null ? String(qr) : null, connection_status: inst.connection_status });
    }),
  );

  // GET /instances/:id/qr.svg — QR renderizado (a UI busca via fetch com o
  // Bearer e injeta o SVG; <img src> não envia Authorization).
  router.get(
    '/:id/qr.svg',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const inst = await requireInstance(repo, req.params.id, auth.orgId);
      const qr = await repo.baileysAuth.get(inst.id, 'qr');
      if (qr == null) throw new HttpError(404, 'Sem QR pendente para esta instância');
      const svg = await QRCode.toString(String(qr), { type: 'svg', margin: 1, width: 280 });
      res.type('image/svg+xml').send(svg);
    }),
  );

  // POST /instances — owner only; sempre na org do usuário.
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      if (auth.role !== 'owner') throw new HttpError(403, 'Apenas o dono pode criar instâncias');
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      }
      const d = parsed.data;
      const created = await repo.instances.create({
        org_id: auth.orgId,
        name: d.name,
        provider_type: d.provider_type,
        phone_number_id: orNull(d.phone_number_id),
        waba_id: orNull(d.waba_id),
        token: orNull(d.token),
        verify_token: orNull(d.verify_token),
        active: d.active,
        connection_status: d.connection_status,
      });
      res.status(201).json(maskInstance(created));
    }),
  );

  // PATCH /instances/:id — owner only, escopado por org.
  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      if (auth.role !== 'owner') throw new HttpError(403, 'Apenas o dono pode editar instâncias');
      await requireInstance(repo, req.params.id, auth.orgId);
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      }
      const updated = await repo.instances.update(req.params.id, parsed.data);
      if (!updated) throw new HttpError(404, 'Instância não encontrada');
      res.json(maskInstance(updated));
    }),
  );

  // DELETE /instances/:id — owner only, escopado por org.
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      if (auth.role !== 'owner') throw new HttpError(403, 'Apenas o dono pode remover instâncias');
      await requireInstance(repo, req.params.id, auth.orgId);
      await repo.instances.delete(req.params.id);
      res.sendStatus(204);
    }),
  );

  return router;
}
