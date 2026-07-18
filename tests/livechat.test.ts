import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { MetaCloudProvider } from '../src/providers/MetaCloudProvider';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';

let repo: Repo;
let inst: Instance;
const BIZ = '15550000000';
const A = '5511111111111';
const B = '5522222222222';

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
  await repo.contacts.upsert({ instance_id: inst.id, phone: A, name: 'Ana', last_seen: null });
  await repo.contacts.upsert({ instance_id: inst.id, phone: B, name: 'Bruno', last_seen: null });
});

async function seedConversationA() {
  // Uso created_at explícito para ordenar de forma determinística.
  await repo.messages.create({
    instance_id: inst.id, direction: 'in', from_number: A, to_number: BIZ, type: 'text',
    content: { body: 'oi 1' }, status: 'delivered', error_code: null, error_message: null,
    wa_message_id: 'a1', campaign_id: null, created_at: '2026-01-01T00:00:01.000Z',
  });
  await repo.messages.create({
    instance_id: inst.id, direction: 'in', from_number: A, to_number: BIZ, type: 'text',
    content: { body: 'oi 2' }, status: 'delivered', error_code: null, error_message: null,
    wa_message_id: 'a2', campaign_id: null, created_at: '2026-01-01T00:00:02.000Z',
  });
  await repo.messages.create({
    instance_id: inst.id, direction: 'in', from_number: A, to_number: BIZ, type: 'text',
    content: { body: 'oi 3' }, status: 'delivered', error_code: null, error_message: null,
    wa_message_id: 'a3', campaign_id: null, created_at: '2026-01-01T00:00:03.000Z',
  });
  await repo.messages.create({
    instance_id: inst.id, direction: 'out', from_number: BIZ, to_number: A, type: 'text',
    content: { body: 'resposta' }, status: 'sent', error_code: null, error_message: null,
    wa_message_id: 'a4', campaign_id: null, created_at: '2026-01-01T00:00:04.000Z',
  });
  await repo.messages.create({
    instance_id: inst.id, direction: 'in', from_number: B, to_number: BIZ, type: 'text',
    content: { body: 'ola' }, status: 'delivered', error_code: null, error_message: null,
    wa_message_id: 'b1', campaign_id: null, created_at: '2026-01-01T00:00:01.500Z',
  });
}

describe('GET /conversations', () => {
  it('agrupa por contato com última mensagem e não-lidas', async () => {
    await seedConversationA();
    const app = createApp(repo);
    const res = await request(app).get(`/api/instances/${inst.id}/conversations`).expect(200);

    expect(res.body.length).toBe(2);
    // Ordenado por última mensagem desc: A (t4) antes de B (t1.5).
    const a = res.body.find((c: { phone: string }) => c.phone === A);
    const b = res.body.find((c: { phone: string }) => c.phone === B);
    expect(res.body[0].phone).toBe(A);
    expect(a.name).toBe('Ana');
    expect(a.unread).toBe(3); // 3 inbound; a outbound não conta
    expect(a.last_message_direction).toBe('out');
    expect(a.last_message_content).toEqual({ body: 'resposta' });
    expect(b.unread).toBe(1);
  });
});

describe('marcar como lida', () => {
  it('POST /read zera as não-lidas da conversa', async () => {
    await seedConversationA();
    const app = createApp(repo);
    await request(app).post(`/api/instances/${inst.id}/conversations/${A}/read`).expect(200);

    const res = await request(app).get(`/api/instances/${inst.id}/conversations`).expect(200);
    const a = res.body.find((c: { phone: string }) => c.phone === A);
    const b = res.body.find((c: { phone: string }) => c.phone === B);
    expect(a.unread).toBe(0); // A foi lida
    expect(b.unread).toBe(1); // B continua não-lida
  });
});

describe('thread paginada', () => {
  it('respeita o limit', async () => {
    await seedConversationA();
    const app = createApp(repo);
    const res = await request(app)
      .get(`/api/instances/${inst.id}/conversations/${A}/messages`)
      .query({ limit: 2 })
      .expect(200);
    expect(res.body.length).toBe(2); // 2 mais recentes (DESC)
  });

  it('conversa com 250 mensagens: agrega certo e a thread é limitada', async () => {
    for (let i = 0; i < 250; i++) {
      await repo.messages.create({
        instance_id: inst.id, direction: 'in', from_number: A, to_number: BIZ, type: 'text',
        content: { body: 'm' + i }, status: 'delivered', error_code: null, error_message: null,
        wa_message_id: 'm' + i, campaign_id: null,
        created_at: '2026-02-01T00:00:' + String(i % 60).padStart(2, '0') + '.000Z',
      });
    }
    const app = createApp(repo);
    const convs = await request(app).get(`/api/instances/${inst.id}/conversations`).expect(200);
    const a = convs.body.find((c: { phone: string }) => c.phone === A);
    expect(a.unread).toBe(250);

    const msgs = await request(app)
      .get(`/api/instances/${inst.id}/conversations/${A}/messages`)
      .query({ limit: 200 })
      .expect(200);
    expect(msgs.body.length).toBe(200); // capado
  });
});

describe('responder pelo Live Chat reaproveita POST /messages', () => {
  it('mensagem enviada vira a última da conversa (direction=out)', async () => {
    function fetchOk() {
      return (async () =>
        ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.x' }] }) }) as unknown as Response) as typeof fetch;
    }
    const app = createApp(repo, { providerFor: () => new MetaCloudProvider({ fetchImpl: fetchOk() }) });
    await request(app)
      .post(`/api/instances/${inst.id}/messages`)
      .send({ type: 'text', to: A, text: 'oi Ana' })
      .expect(201);

    const convs = await request(app).get(`/api/instances/${inst.id}/conversations`).expect(200);
    const a = convs.body.find((c: { phone: string }) => c.phone === A);
    expect(a.last_message_direction).toBe('out');
    // Saída de texto é logada como { type, text } (input menos `to`).
    expect(a.last_message_content).toMatchObject({ text: 'oi Ana' });
  });
});

describe('regra crítica de layout (grid-template-rows explícito)', () => {
  it('o CSS do container da conversa define grid-template-rows: auto 1fr auto', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'styles.css'), 'utf8');
    const block = css.slice(css.indexOf('.conversation {'));
    expect(block).toMatch(/grid-template-rows:\s*auto 1fr auto/);
  });
});
