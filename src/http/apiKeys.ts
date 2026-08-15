import { Router } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import type { ApiKey } from '../repo/types';
import { newApiKey } from '../util/auth';
import { asyncHandler, getAuth, HttpError, requireInstance } from './util';

const createSchema = z.object({
  label: z.string().min(1).max(120),
  /**
   * true (default): a chave vale só para ESTA instância.
   * false: vale para qualquer instância da MESMA org (nunca global).
   */
  scope_instance: z.boolean().default(true),
});

/**
 * Vista pública de uma chave: TUDO menos o hash. Nem o hash sai daqui — ele
 * não é usável para autenticar (a chave em claro é que é), mas expor hash de
 * segredo é hábito ruim que um dia encontra um algoritmo fraco.
 */
function maskKey(k: ApiKey) {
  return {
    id: k.id,
    label: k.label,
    org_id: k.org_id,
    instance_id: k.instance_id,
    created_at: k.created_at,
    created_by: k.created_by,
    revoked_at: k.revoked_at,
    last_used_at: k.last_used_at,
    active: k.revoked_at == null,
  };
}

/**
 * Rotas de CHAVES DE API (P6.3) — gestão feita por gente logada (owner), para
 * uso por máquina. A chave em claro aparece UMA vez, na resposta do POST, e
 * nunca mais: o banco guarda só o SHA-256.
 *
 * Montado como `ownerOnly: true` em INSTANCE_SCOPED_MOUNTS, então herda o
 * escopo por org do requireInstance e entra automaticamente no teste de
 * cross-org (tests/orgscope.test.ts).
 */
export function createApiKeysRouter(repo: Repo): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const inst = await requireInstance(repo, req.params.id, auth.orgId);
      // Lista as chaves da ORG que servem a esta instância: as presas a ela
      // mais as de org inteira (instance_id null), que também a alcançam.
      const todas = await repo.apiKeys.listByOrg(auth.orgId);
      res.json(
        todas.filter((k) => k.instance_id == null || k.instance_id === inst.id).map(maskKey),
      );
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const inst = await requireInstance(repo, req.params.id, auth.orgId);
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);

      const { key, hash } = newApiKey();
      const criada = await repo.apiKeys.create({
        org_id: auth.orgId, // do CONTEXTO autenticado, nunca do corpo
        instance_id: parsed.data.scope_instance ? inst.id : null,
        key_hash: hash,
        label: parsed.data.label,
        created_by: auth.userId,
      });

      // ÚNICA vez que o valor em claro existe fora de quem o vai usar.
      res.status(201).json({
        ...maskKey(criada),
        key,
        aviso:
          'Guarde esta chave agora: ela não pode ser exibida de novo. ' +
          'Perdida, revogue esta e crie outra.',
      });
    }),
  );

  /**
   * Revogação = soft delete. A linha fica: é ela que explica os envios que a
   * chave fez. DELETE de verdade apagaria a resposta de "quem mandou isto?".
   */
  router.post(
    '/:keyId/revoke',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      await requireInstance(repo, req.params.id, auth.orgId);
      const ok = await repo.apiKeys.revoke(
        auth.orgId,
        req.params.keyId,
        new Date().toISOString(),
      );
      // 404 cobre "não existe nesta org" E "já estava revogada": nos dois casos
      // esta requisição não revogou nada, e dizer 204 seria mentir.
      if (!ok) throw new HttpError(404, 'Chave não encontrada ou já revogada');
      res.sendStatus(204);
    }),
  );

  return router;
}
