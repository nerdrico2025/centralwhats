import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { resolveVarSource } from '../src/domain/campaigns';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';

let repo: Repo;
let inst: Instance;
let app: ReturnType<typeof createApp>;

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

describe('resolveVarSource', () => {
  const contact = {
    id: 'c1', instance_id: inst?.id ?? 'x', phone: '5511999998888', name: 'Rafael',
    last_seen: null, last_read_at: null,
  };
  const crm = {
    id: 'r1', instance_id: 'x', contact_id: 'c1', phone: '5511999998888', name: 'Rafael',
    stage: 'cliente', score: 10, notes: null, custom_fields: { plano: 'pro' },
  };
  it('resolve name/phone/crm/custom_fields/literal', () => {
    expect(resolveVarSource('name', contact, crm)).toBe('Rafael');
    expect(resolveVarSource('phone', contact, crm)).toBe('5511999998888');
    expect(resolveVarSource('crm.stage', contact, crm)).toBe('cliente');
    expect(resolveVarSource('crm.score', contact, crm)).toBe('10');
    expect(resolveVarSource('crm.custom_fields.plano', contact, crm)).toBe('pro');
    expect(resolveVarSource('lit:Olá', contact, crm)).toBe('Olá');
    expect(resolveVarSource('desconhecido', contact, crm)).toBe('');
  });
});

describe('Listas — CRUD e contatos', () => {
  it('cria lista, adiciona e remove contatos', async () => {
    const c1 = await repo.contacts.upsert({ instance_id: inst.id, phone: '5511111111111', name: 'A', last_seen: null });
    const c2 = await repo.contacts.upsert({ instance_id: inst.id, phone: '5522222222222', name: 'B', last_seen: null });

    const list = await request(app).post(`/api/instances/${inst.id}/lists`).send({ name: 'VIP' }).expect(201);
    await request(app)
      .post(`/api/instances/${inst.id}/lists/${list.body.id}/contacts`)
      .send({ contactIds: [c1.id, c2.id] })
      .expect(200);

    let contacts = await request(app).get(`/api/instances/${inst.id}/lists/${list.body.id}/contacts`).expect(200);
    expect(contacts.body.length).toBe(2);

    await request(app)
      .post(`/api/instances/${inst.id}/lists/${list.body.id}/contacts/remove`)
      .send({ contactIds: [c1.id] })
      .expect(200);
    contacts = await request(app).get(`/api/instances/${inst.id}/lists/${list.body.id}/contacts`).expect(200);
    expect(contacts.body.length).toBe(1);
  });
});

describe('Campanha — criação + preview de destinatários (SEM envio)', () => {
  it('monta campanha completa e resolve destinatários com variáveis', async () => {
    // 2 contatos + CRM + template sincronizado + 2 listas (com overlap).
    const a = await repo.contacts.upsert({ instance_id: inst.id, phone: '5511111111111', name: 'Ana', last_seen: null });
    const b = await repo.contacts.upsert({ instance_id: inst.id, phone: '5522222222222', name: 'Bruno', last_seen: null });
    await repo.crm.upsert({
      instance_id: inst.id, contact_id: a.id, phone: a.phone, name: 'Ana',
      stage: 'cliente', score: 5, notes: null, custom_fields: { plano: 'pro' },
    });
    const tpl = await repo.templates.upsert({
      instance_id: inst.id, name: 'promo', category: 'MARKETING', language: 'pt_BR',
      status: 'APPROVED', components: [], wa_template_id: 'tpl_1',
    });
    const l1 = await repo.lists.create({ instance_id: inst.id, name: 'L1' });
    const l2 = await repo.lists.create({ instance_id: inst.id, name: 'L2' });
    await repo.lists.addContacts(inst.id, l1.id, [a.id, b.id]);
    await repo.lists.addContacts(inst.id, l2.id, [b.id]); // overlap com b

    const created = await request(app)
      .post(`/api/instances/${inst.id}/campaigns`)
      .send({
        name: 'Promo Julho',
        template_id: tpl.id,
        list_ids: [l1.id, l2.id],
        variables: { '1': 'name', '2': 'crm.custom_fields.plano' },
        interval_ms: 1500,
      })
      .expect(201);
    // total_recipients = contatos distintos (a, b) = 2, apesar do overlap.
    expect(created.body.total_recipients).toBe(2);
    expect(created.body.status).toBe('draft');
    expect(created.body.interval_ms).toBe(1500);

    const preview = await request(app)
      .get(`/api/instances/${inst.id}/campaigns/${created.body.id}/recipients`)
      .expect(200);
    expect(preview.body.total).toBe(2);
    expect(preview.body.template).toEqual({ name: 'promo', language: 'pt_BR' });

    const ana = preview.body.recipients.find((r: { name: string }) => r.name === 'Ana');
    expect(ana.vars['1']).toBe('Ana');
    expect(ana.vars['2']).toBe('pro');
    const bruno = preview.body.recipients.find((r: { name: string }) => r.name === 'Bruno');
    expect(bruno.vars['1']).toBe('Bruno');
    expect(bruno.vars['2']).toBe(''); // sem CRM → vazio

    // NADA foi enviado: nenhuma mensagem de saída registrada.
    const msgs = await repo.messages.listByContact(inst.id, a.phone);
    expect(msgs.filter((m) => m.direction === 'out').length).toBe(0);
  });

  it('template_id inexistente → 400', async () => {
    await request(app)
      .post(`/api/instances/${inst.id}/campaigns`)
      .send({ name: 'X', template_id: 'nope', list_ids: [] })
      .expect(400);
  });
});
