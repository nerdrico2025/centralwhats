import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { hashPassword, verifyPassword, signToken, verifyToken } from '../src/util/auth';
import type { Repo } from '../src/repo';

let repo: Repo;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  app = createApp(repo);
});

async function registerOrg(orgName: string, email: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ org_name: orgName, email, password: 'senha-secreta-123' })
    .expect(201);
  return res.body as { token: string; user: { id: string; org_id: string }; org: { id: string } };
}

describe('util/auth (unitário)', () => {
  it('hash/verify de senha (scrypt) e JWT com expiração', () => {
    const stored = hashPassword('minhasenha');
    expect(verifyPassword('minhasenha', stored)).toBe(true);
    expect(verifyPassword('errada', stored)).toBe(false);

    const token = signToken({ sub: 'u1', org_id: 'o1', role: 'owner' }, 'seg');
    const payload = verifyToken(token, 'seg');
    expect(payload).toMatchObject({ sub: 'u1', org_id: 'o1', role: 'owner' });
    expect(verifyToken(token, 'outro-segredo')).toBeNull(); // assinatura errada
    const expired = signToken({ sub: 'u1', org_id: 'o1', role: 'owner' }, 'seg', -10);
    expect(verifyToken(expired, 'seg')).toBeNull(); // expirado
  });
});

describe('migração sem perda (org default)', () => {
  it('instância pré-existente é associada à org default e a V1 segue funcionando', async () => {
    // Instância criada "antes da V2" (sem org explícita) → org_default.
    const inst = await repo.instances.create({
      name: 'V1', provider_type: 'meta', phone_number_id: '111', waba_id: null,
      token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });
    expect(inst.org_id).toBe('org_default');
    expect(await repo.orgs.getById('org_default')).not.toBeNull();

    // MODO BOOTSTRAP: sem usuários, requests sem token operam na org default.
    const list = await request(app).get('/api/instances').expect(200);
    expect(list.body.length).toBe(1);
  });
});

describe('registro, login e trancamento', () => {
  it('register cria org+owner; login devolve token; senha nunca vaza', async () => {
    const reg = await registerOrg('ACME', 'dono@acme.com');
    expect(reg.user).not.toHaveProperty('password_hash');
    expect(JSON.stringify(reg)).not.toContain('senha-secreta-123');

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'dono@acme.com', password: 'senha-secreta-123' })
      .expect(200);
    expect(login.body.token).toBeDefined();

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'dono@acme.com', password: 'errada' })
      .expect(401);
  });

  it('após o primeiro usuário, requests sem token são 401 (bootstrap desligado)', async () => {
    await request(app).get('/api/instances').expect(200); // bootstrap ativo
    await registerOrg('ACME', 'dono@acme.com');
    await request(app).get('/api/instances').expect(401); // trancou
  });

  it('email duplicado → 409', async () => {
    await registerOrg('A', 'x@x.com');
    await request(app)
      .post('/api/auth/register')
      .send({ org_name: 'B', email: 'x@x.com', password: 'senha-secreta-123' })
      .expect(409);
  });
});

describe('ISOLAMENTO CROSS-ORG (critério de aceite)', () => {
  it('org A não enxerga nem acessa dados da org B', async () => {
    const a = await registerOrg('Org A', 'a@a.com');
    const b = await registerOrg('Org B', 'b@b.com');

    // Cada org cria sua instância.
    const instA = await request(app)
      .post('/api/instances')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'Loja A', phone_number_id: '111' })
      .expect(201);
    const instB = await request(app)
      .post('/api/instances')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ name: 'Loja B', phone_number_id: '222' })
      .expect(201);

    // Listagem: cada um vê SÓ a sua.
    const listA = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${a.token}`)
      .expect(200);
    expect(listA.body.map((i: { name: string }) => i.name)).toEqual(['Loja A']);

    // Acesso direto cruzado: 404 (nem revela que existe).
    await request(app)
      .get(`/api/instances/${instB.body.id}`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(404);
    await request(app)
      .get(`/api/instances/${instA.body.id}/contacts`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
    await request(app)
      .get(`/api/instances/${instA.body.id}/conversations`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
    await request(app)
      .patch(`/api/instances/${instA.body.id}`)
      .set('Authorization', `Bearer ${b.token}`)
      .send({ name: 'hackeada' })
      .expect(404);
    await request(app)
      .delete(`/api/instances/${instA.body.id}`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);

    // Dados criados por A ficam invisíveis para B mesmo via rotas escopadas.
    await request(app)
      .post(`/api/instances/${instA.body.id}/contacts`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ phone: '5511999998888', name: 'Cliente A' })
      .expect(201);
    await request(app)
      .get(`/api/instances/${instA.body.id}/contacts`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);

    // Dashboard da org A não conta instâncias da org B.
    const dash = await request(app)
      .get(`/api/instances/${instA.body.id}/dashboard`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(200);
    expect(dash.body.active_instances).toBe(1);
    expect(dash.body.by_instance.map((i: { name: string }) => i.name)).toEqual(['Loja A']);
  });
});

describe('papéis: owner × agent', () => {
  it('agent só atende no Live Chat; owner gerencia', async () => {
    const a = await registerOrg('ACME', 'dono@acme.com');
    const instRes = await request(app)
      .post('/api/instances')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'Loja', phone_number_id: '111' })
      .expect(201);
    const instId = instRes.body.id;

    // Owner cria um agent na própria org.
    await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ email: 'agente@acme.com', password: 'senha-agente-123', role: 'agent' })
      .expect(201);
    const agentLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'agente@acme.com', password: 'senha-agente-123' })
      .expect(200);
    const agentToken = agentLogin.body.token;

    // Agent PODE: listar instâncias e usar o Live Chat.
    await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(200);
    await request(app)
      .get(`/api/instances/${instId}/conversations`)
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(200);

    // Agent NÃO PODE: criar instância, campanhas, fluxos, usuários, dashboard.
    await request(app)
      .post('/api/instances')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ name: 'X' })
      .expect(403);
    await request(app)
      .get(`/api/instances/${instId}/campaigns`)
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);
    await request(app)
      .get(`/api/instances/${instId}/flows`)
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);
    await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);
    await request(app)
      .get(`/api/instances/${instId}/dashboard`)
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);
  });

  it('usuário criado pelo owner nasce SEMPRE na org do owner', async () => {
    const a = await registerOrg('A', 'a@a.com');
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ email: 'novo@a.com', password: 'senha-nova-123' })
      .expect(201);
    expect(created.body.org_id).toBe(a.org.id);
  });
});
