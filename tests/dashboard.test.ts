import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { buildVolumeSeries } from '../src/util/metrics';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';

let repo: Repo;
let inst: Instance;

async function msg(direction: 'in' | 'out', type: string, status: string, createdAt: string, id: string) {
  await repo.messages.create({
    instance_id: inst.id,
    direction,
    from_number: direction === 'in' ? '5511999998888' : '15550000000',
    to_number: direction === 'in' ? '15550000000' : '5511999998888',
    type,
    content: { body: 'x' },
    status,
    error_code: null,
    error_message: null,
    wa_message_id: id,
    campaign_id: null,
    created_at: createdAt,
  });
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
});

describe('buildVolumeSeries', () => {
  it('preenche 30 dias e soma por direção', () => {
    const now = new Date('2026-07-17T12:00:00Z');
    const rows = [
      { d: '2026-07-17', direction: 'out', c: 3 },
      { d: '2026-07-17', direction: 'in', c: 2 },
      { d: '2026-07-10', direction: 'out', c: 1 },
    ];
    const s = buildVolumeSeries(rows, 30, now);
    expect(s.length).toBe(30);
    expect(s[s.length - 1]).toEqual({ date: '2026-07-17', sent: 3, received: 2 });
    expect(s.find((d) => d.date === '2026-07-10')).toEqual({
      date: '2026-07-10',
      sent: 1,
      received: 0,
    });
  });
});

describe('GET /dashboard — métricas agregadas reais', () => {
  it('reflete enviadas/recebidas, taxas, tipos e por instância', async () => {
    const today = new Date().toISOString();
    await repo.contacts.upsert({ instance_id: inst.id, phone: '5511999998888', name: 'C', last_seen: null });
    // saída: 1 sent, 1 delivered, 2 read, 1 failed  => out_total=5
    await msg('out', 'text', 'sent', today, 'o1');
    await msg('out', 'text', 'delivered', today, 'o2');
    await msg('out', 'text', 'read', today, 'o3');
    await msg('out', 'template', 'read', today, 'o4');
    await msg('out', 'text', 'failed', today, 'o5');
    // entrada: 3 recebidas
    await msg('in', 'text', 'delivered', today, 'i1');
    await msg('in', 'image', 'delivered', today, 'i2');
    await msg('in', 'text', 'delivered', today, 'i3');

    const res = await request(createApp(repo)).get(`/api/instances/${inst.id}/dashboard`).expect(200);
    const d = res.body;
    expect(d.sent).toBe(5);
    expect(d.received).toBe(3);
    expect(d.contacts).toBe(1);
    expect(d.active_instances).toBe(1);
    // saída: sent, delivered, read, read, failed → out_total=5
    // entrega = (delivered+read)/out_total = (1+2)/5 = 0.6
    expect(d.delivery_rate).toBeCloseTo(0.6, 5);
    // leitura = read/out_total = 2/5 = 0.4
    expect(d.read_rate).toBeCloseTo(0.4, 5);

    expect(d.volume_30d.length).toBe(30);
    const totalType = d.by_type.reduce((s: number, t: { count: number }) => s + t.count, 0);
    expect(totalType).toBe(8); // todas as mensagens
    expect(d.by_instance[0]).toMatchObject({ name: 'Loja', total: 8 });
  });

  it('instância sem mensagens retorna zeros sem quebrar', async () => {
    const res = await request(createApp(repo)).get(`/api/instances/${inst.id}/dashboard`).expect(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.delivery_rate).toBe(0);
    expect(res.body.volume_30d.length).toBe(30);
  });

  it('performático com muitas mensagens (agregação, não N+1)', async () => {
    const today = new Date().toISOString();
    for (let i = 0; i < 500; i++) {
      await msg(i % 2 ? 'in' : 'out', 'text', 'delivered', today, 'm' + i);
    }
    const t0 = Date.now();
    const res = await request(createApp(repo)).get(`/api/instances/${inst.id}/dashboard`).expect(200);
    const elapsed = Date.now() - t0;
    expect(res.body.sent + res.body.received).toBe(500);
    expect(elapsed).toBeLessThan(500); // agregado, rápido
  });
});
