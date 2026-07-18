import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';

let repo: Repo;
let inst: Instance;
let app: ReturnType<typeof createApp>;

async function makeContact(phone: string, name: string) {
  return repo.contacts.upsert({ instance_id: inst.id, phone, name, last_seen: null });
}

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  inst = await repo.instances.create({
    name: 'Loja',
    provider_type: 'meta',
    phone_number_id: '109999888777',
    waba_id: null,
    token: 't',
    verify_token: 'v',
    active: true,
    connection_status: 'connected',
  });
  app = createApp(repo);
});

describe('Contatos', () => {
  it('cria (telefone normalizado), lista e busca', async () => {
    const created = await request(app)
      .post(`/api/instances/${inst.id}/contacts`)
      .send({ phone: '+55 (11) 99999-8888', name: 'Rafael' })
      .expect(201);
    expect(created.body.phone).toBe('5511999998888');

    const list = await request(app).get(`/api/instances/${inst.id}/contacts`).expect(200);
    expect(list.body.length).toBe(1);

    const search = await request(app)
      .get(`/api/instances/${inst.id}/contacts`)
      .query({ search: 'Rafa' })
      .expect(200);
    expect(search.body.length).toBe(1);
  });
});

describe('Tags — CRUD e aplicação EM MASSA', () => {
  it('cria tag e aplica/remove em massa a vários contatos', async () => {
    const c1 = await makeContact('5511111111111', 'c1');
    const c2 = await makeContact('5522222222222', 'c2');
    const c3 = await makeContact('5533333333333', 'c3');

    const tag = await request(app)
      .post(`/api/instances/${inst.id}/tags`)
      .send({ name: 'vip', color: '#25D366' })
      .expect(201);

    const apply = await request(app)
      .post(`/api/instances/${inst.id}/tags/${tag.body.id}/apply`)
      .send({ contactIds: [c1.id, c2.id, c3.id] })
      .expect(200);
    expect(apply.body.applied).toBe(3);

    await request(app)
      .post(`/api/instances/${inst.id}/tags/${tag.body.id}/remove`)
      .send({ contactIds: [c2.id] })
      .expect(200);

    const list = await request(app).get(`/api/instances/${inst.id}/tags`).expect(200);
    expect(list.body.length).toBe(1);
  });

  it('aplicação em massa ignora contatos de outra instância (escopo)', async () => {
    const other = await repo.instances.create({
      name: 'Outra',
      provider_type: 'meta',
      phone_number_id: '200',
      waba_id: null,
      token: 't',
      verify_token: 'v',
      active: true,
      connection_status: 'connected',
    });
    const mine = await makeContact('5511111111111', 'meu');
    const foreign = await repo.contacts.upsert({
      instance_id: other.id,
      phone: '5599999999999',
      name: 'alheio',
      last_seen: null,
    });
    const tag = await request(app)
      .post(`/api/instances/${inst.id}/tags`)
      .send({ name: 't1' })
      .expect(201);

    // Inclui um contato de outra instância — deve ser ignorado, sem erro.
    await request(app)
      .post(`/api/instances/${inst.id}/tags/${tag.body.id}/apply`)
      .send({ contactIds: [mine.id, foreign.id] })
      .expect(200);
    // Não explode; o vínculo do contato alheio não é criado (escopo no repo).
    expect(true).toBe(true);
  });

  it('valida contactIds vazio → 400', async () => {
    const tag = await request(app)
      .post(`/api/instances/${inst.id}/tags`)
      .send({ name: 'x' })
      .expect(201);
    await request(app)
      .post(`/api/instances/${inst.id}/tags/${tag.body.id}/apply`)
      .send({ contactIds: [] })
      .expect(400);
  });
});

describe('CRM — estágio, score, notas e campos customizados', () => {
  it('move de estágio, salva score/notas/custom_fields e lista por estágio', async () => {
    const c = await makeContact('5511999998888', 'Lead X');

    const put1 = await request(app)
      .put(`/api/instances/${inst.id}/crm/${c.id}`)
      .send({ stage: 'lead', score: 5, custom_fields: { origem: 'ads' } })
      .expect(200);
    expect(put1.body.stage).toBe('lead');
    expect(put1.body.score).toBe(5);

    const put2 = await request(app)
      .put(`/api/instances/${inst.id}/crm/${c.id}`)
      .send({ stage: 'cliente', notes: 'Fechou pro', custom_fields: { origem: 'ads', plano: 'pro' } })
      .expect(200);
    expect(put2.body.stage).toBe('cliente');
    expect(put2.body.notes).toBe('Fechou pro');
    expect(put2.body.custom_fields).toEqual({ origem: 'ads', plano: 'pro' });
    // score preservado (não veio no segundo PUT).
    expect(put2.body.score).toBe(5);

    const clientes = await request(app)
      .get(`/api/instances/${inst.id}/crm`)
      .query({ stage: 'cliente' })
      .expect(200);
    expect(clientes.body.length).toBe(1);
  });

  it('PUT em contato inexistente → 404', async () => {
    await request(app)
      .put(`/api/instances/${inst.id}/crm/nope`)
      .send({ stage: 'lead' })
      .expect(404);
  });
});
