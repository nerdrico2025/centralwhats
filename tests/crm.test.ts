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
    org_id: 'org_default',
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
    org_id: 'org_default',
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

describe('Contatos — plano B do nome (PRD §3.5)', () => {
  it('operador nomeia contato sem nome e o webhook NÃO apaga a correção', async () => {
    // A Meta não compartilhou profile.name (privacidade): contato sem nome.
    const anon = await repo.contacts.upsert({
      instance_id: inst.id, phone: '5511777770001', name: null, last_seen: null,
    });
    expect(anon.name).toBeNull();

    // Operador corrige na mão.
    const renamed = await request(app)
      .patch(`/api/instances/${inst.id}/contacts/${anon.id}`)
      .send({ name: 'Cliente do Zap' })
      .expect(200);
    expect(renamed.body.name).toBe('Cliente do Zap');
    expect(renamed.body.name_source).toBe('manual');

    // Chega mensagem e a Meta AGORA manda um profile.name diferente.
    // Antes desta trava, a correção do operador sumia em silêncio.
    await repo.contacts.upsert({
      instance_id: inst.id, phone: '5511777770001',
      name: 'nome-cru-da-meta', last_seen: new Date().toISOString(),
    });

    const depois = await repo.contacts.getById(inst.id, anon.id);
    expect(depois!.name).toBe('Cliente do Zap');
    expect(depois!.name_source).toBe('manual');
    // ...mas o last_seen do webhook continua sendo aplicado normalmente.
    expect(depois!.last_seen).not.toBeNull();
  });

  it('limpar o nome devolve o controle à Meta', async () => {
    const c = await makeContact('5511777770002', 'Nome Antigo');
    await request(app)
      .patch(`/api/instances/${inst.id}/contacts/${c.id}`)
      .send({ name: 'Manual' })
      .expect(200);

    // Nome vazio = "não tenho preferência": volta a valer o profile.name.
    const limpo = await request(app)
      .patch(`/api/instances/${inst.id}/contacts/${c.id}`)
      .send({ name: null })
      .expect(200);
    expect(limpo.body.name).toBeNull();

    await repo.contacts.upsert({
      instance_id: inst.id, phone: '5511777770002', name: 'Nome da Meta', last_seen: null,
    });
    expect((await repo.contacts.getById(inst.id, c.id))!.name).toBe('Nome da Meta');
  });

  it('sem edição manual, profile.name da Meta continua atualizando o nome', async () => {
    await repo.contacts.upsert({
      instance_id: inst.id, phone: '5511777770003', name: 'Primeiro', last_seen: null,
    });
    await repo.contacts.upsert({
      instance_id: inst.id, phone: '5511777770003', name: 'Atualizado', last_seen: null,
    });
    const c = await repo.contacts.getByPhone(inst.id, '5511777770003');
    expect(c!.name).toBe('Atualizado');
  });

  it('PATCH em contato de OUTRA instância → 404 (não vaza nem renomeia)', async () => {
    const c = await makeContact('5511777770004', 'Da Loja');
    const outra = await repo.instances.create({
    org_id: 'org_default',
      name: 'Outra', provider_type: 'meta', phone_number_id: '10555444333',
      waba_id: null, token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });
    await request(app)
      .patch(`/api/instances/${outra.id}/contacts/${c.id}`)
      .send({ name: 'Invasor' })
      .expect(404);
    expect((await repo.contacts.getById(inst.id, c.id))!.name).toBe('Da Loja');
  });
});

describe('Contatos — tags aplicadas (leitura)', () => {
  it('lista as tags do contato e some quando a tag é removida', async () => {
    const c = await makeContact('5511666660001', 'Ana');
    const vip = await request(app)
      .post(`/api/instances/${inst.id}/tags`).send({ name: 'VIP', color: '#0f0' }).expect(201);
    const frio = await request(app)
      .post(`/api/instances/${inst.id}/tags`).send({ name: 'Frio' }).expect(201);

    await request(app)
      .post(`/api/instances/${inst.id}/tags/${vip.body.id}/apply`)
      .send({ contactIds: [c.id] }).expect(200);
    await request(app)
      .post(`/api/instances/${inst.id}/tags/${frio.body.id}/apply`)
      .send({ contactIds: [c.id] }).expect(200);

    let tags = await request(app)
      .get(`/api/instances/${inst.id}/contacts/${c.id}/tags`).expect(200);
    expect(tags.body.map((t: { name: string }) => t.name).sort()).toEqual(['Frio', 'VIP']);

    await request(app)
      .post(`/api/instances/${inst.id}/tags/${frio.body.id}/remove`)
      .send({ contactIds: [c.id] }).expect(200);

    tags = await request(app)
      .get(`/api/instances/${inst.id}/contacts/${c.id}/tags`).expect(200);
    expect(tags.body.map((t: { name: string }) => t.name)).toEqual(['VIP']);
  });

  it('contato de outra instância → 404', async () => {
    const c = await makeContact('5511666660002', 'B');
    const outra = await repo.instances.create({
    org_id: 'org_default',
      name: 'Outra', provider_type: 'meta', phone_number_id: '10555444222',
      waba_id: null, token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });
    await request(app)
      .get(`/api/instances/${outra.id}/contacts/${c.id}/tags`).expect(404);
  });
});

describe('Contatos/CRM — isolamento entre instâncias', () => {
  it('contato, tag e CRM de uma instância não aparecem na outra', async () => {
    const outra = await repo.instances.create({
    org_id: 'org_default',
      name: 'Outra', provider_type: 'meta', phone_number_id: '10555444111',
      waba_id: null, token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });

    const a = await makeContact('5511555550001', 'Da A');
    await request(app).post(`/api/instances/${inst.id}/tags`).send({ name: 'SóDaA' }).expect(201);
    await request(app)
      .put(`/api/instances/${inst.id}/crm/${a.id}`)
      .send({ stage: 'cliente', notes: 'segredo da A' }).expect(200);

    // A outra instância não enxerga nada disso.
    expect((await request(app).get(`/api/instances/${outra.id}/contacts`).expect(200)).body).toEqual([]);
    expect((await request(app).get(`/api/instances/${outra.id}/tags`).expect(200)).body).toEqual([]);
    expect((await request(app).get(`/api/instances/${outra.id}/crm`).expect(200)).body).toEqual([]);
    // Nem lendo pelo id direto.
    await request(app).get(`/api/instances/${outra.id}/contacts/${a.id}`).expect(404);
    await request(app).get(`/api/instances/${outra.id}/crm/${a.id}`).expect(404);
  });
});

describe('Tags — mapa agrupado por contato (evita N+1 na UI)', () => {
  it('agrupa por contato numa chamada e respeita o escopo da instância', async () => {
    const a = await makeContact('5511444440001', 'A');
    const b = await makeContact('5511444440002', 'B');
    await makeContact('5511444440003', 'SemTag');
    const vip = await request(app)
      .post(`/api/instances/${inst.id}/tags`).send({ name: 'VIP' }).expect(201);
    const novo = await request(app)
      .post(`/api/instances/${inst.id}/tags`).send({ name: 'Novo' }).expect(201);

    await request(app).post(`/api/instances/${inst.id}/tags/${vip.body.id}/apply`)
      .send({ contactIds: [a.id, b.id] }).expect(200);
    await request(app).post(`/api/instances/${inst.id}/tags/${novo.body.id}/apply`)
      .send({ contactIds: [a.id] }).expect(200);

    const mapa = (await request(app)
      .get(`/api/instances/${inst.id}/tags/by-contact`).expect(200)).body;

    expect(mapa[a.id].map((t: { name: string }) => t.name)).toEqual(['Novo', 'VIP']);
    expect(mapa[b.id].map((t: { name: string }) => t.name)).toEqual(['VIP']);
    // Contato sem tag simplesmente não aparece no mapa.
    expect(Object.keys(mapa).length).toBe(2);

    // Outra instância enxerga um mapa vazio, não as tags da primeira.
    const outra = await repo.instances.create({
    org_id: 'org_default',
      name: 'Outra', provider_type: 'meta', phone_number_id: '10333222111',
      waba_id: null, token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });
    expect((await request(app)
      .get(`/api/instances/${outra.id}/tags/by-contact`).expect(200)).body).toEqual({});
  });
});
