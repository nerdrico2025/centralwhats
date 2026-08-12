import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp, INSTANCE_SCOPED_MOUNTS } from '../src/http/app';
import { resetEnvCache } from '../src/config';
import type { Repo } from '../src/repo';

/**
 * COBERTURA DE ESCOPO CROSS-ORG — o teste que pega REGRESSÃO FUTURA.
 *
 * Não escolhe algumas rotas "principais": percorre a tabela
 * INSTANCE_SCOPED_MOUNTS, que é a MESMA lista da qual o app monta os routers.
 * Router novo entra aqui automaticamente — e, se ele esquecer o `orgId` no
 * requireInstance, este teste falha antes do deploy.
 */

let repo: Repo;
let app: ReturnType<typeof createApp>;

const SENHA = 'senha-secreta-123';

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  app = createApp(repo);
});

afterEach(() => {
  delete process.env.PUBLIC_SIGNUP;
  resetEnvCache();
});

async function registerOrg(orgName: string, email: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ org_name: orgName, email, password: SENHA })
    .expect(201);
  return res.body as { token: string; org: { id: string } };
}

describe('escopo por org — TODAS as rotas montadas sob /api/instances/:id', () => {
  it('cada mount responde 404 para instância de outra conta (e existe de fato)', async () => {
    const a = await registerOrg('Org A', 'a@a.com');
    process.env.PUBLIC_SIGNUP = 'true';
    resetEnvCache();
    const b = await registerOrg('Org B', 'b@b.com');

    const instA = (
      await request(app)
        .post('/api/instances')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ name: 'Loja A', phone_number_id: '111' })
        .expect(201)
    ).body as { id: string };
    const instB = (
      await request(app)
        .post('/api/instances')
        .set('Authorization', `Bearer ${b.token}`)
        .send({ name: 'Loja B', phone_number_id: '222' })
        .expect(201)
    ).body as { id: string };

    expect(INSTANCE_SCOPED_MOUNTS.length).toBeGreaterThan(0);

    for (const mount of INSTANCE_SCOPED_MOUNTS) {
      const proprio = `/api/instances/${instA.id}/${mount.segment}`;
      const alheio = `/api/instances/${instB.id}/${mount.segment}`;

      // (1) A rota EXISTE: no caminho próprio, ao menos um verbo não é 404.
      // Sem esta metade, um mount removido por engano passaria no teste (404
      // por ausência de rota é indistinguível de 404 por escopo).
      const proprioGet = await request(app)
        .get(proprio)
        .set('Authorization', `Bearer ${a.token}`);
      const proprioPost = await request(app)
        .post(proprio)
        .set('Authorization', `Bearer ${a.token}`)
        .send({});
      expect(
        proprioGet.status !== 404 || proprioPost.status !== 404,
        `mount "${mount.segment}" não respondeu no caminho próprio (GET ${proprioGet.status}, POST ${proprioPost.status})`,
      ).toBe(true);

      // (2) O ESCOPO vale: na instância da outra conta, tudo é 404.
      const alheioGet = await request(app)
        .get(alheio)
        .set('Authorization', `Bearer ${a.token}`);
      const alheioPost = await request(app)
        .post(alheio)
        .set('Authorization', `Bearer ${a.token}`)
        .send({});
      expect(alheioGet.status, `GET cross-org em "${mount.segment}"`).toBe(404);
      expect(alheioPost.status, `POST cross-org em "${mount.segment}"`).toBe(404);
    }
  });

  it('agent é barrado nos mounts de gestão e passa nos de atendimento', async () => {
    const a = await registerOrg('Org A', 'a@a.com');
    const inst = (
      await request(app)
        .post('/api/instances')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ name: 'Loja A', phone_number_id: '111' })
        .expect(201)
    ).body as { id: string };

    const inv = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ email: 'agente@a.com', role: 'agent' })
      .expect(201);
    const agente = await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.body.token, password: 'senha-do-agente-1' })
      .expect(201);

    for (const mount of INSTANCE_SCOPED_MOUNTS.filter((mo) => mo.ownerOnly)) {
      const res = await request(app)
        .get(`/api/instances/${inst.id}/${mount.segment}`)
        .set('Authorization', `Bearer ${agente.body.token}`);
      expect(res.status, `agent deveria tomar 403 em "${mount.segment}"`).toBe(403);
    }
    for (const mount of INSTANCE_SCOPED_MOUNTS.filter((mo) => !mo.ownerOnly)) {
      const res = await request(app)
        .get(`/api/instances/${inst.id}/${mount.segment}`)
        .set('Authorization', `Bearer ${agente.body.token}`);
      expect(res.status, `agent NÃO deveria tomar 403 em "${mount.segment}"`).not.toBe(403);
    }
  });
});

describe('instância sem dono é proibida (L3)', () => {
  it('repo.instances.create sem org_id falha ALTO (nunca cai num default)', async () => {
    await expect(
      repo.instances.create({
        // @ts-expect-error — o tipo já proíbe; o teste garante a trava em runtime
        org_id: undefined,
        name: 'Órfã', provider_type: 'meta', phone_number_id: '999', waba_id: null,
        token: null, verify_token: null, active: true, connection_status: 'disconnected',
      }),
    ).rejects.toThrow(/org_id é obrigatório/i);
  });

  it('a auditoria de órfãs não encontra nada num banco migrado', async () => {
    await repo.instances.create({
      org_id: 'org_default',
      name: 'OK', provider_type: 'meta', phone_number_id: '111', waba_id: null,
      token: null, verify_token: null, active: true, connection_status: 'disconnected',
    });
    expect(await repo.maintenance.findOrphanInstances()).toEqual([]);
  });
});
