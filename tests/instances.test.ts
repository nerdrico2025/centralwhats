import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { resolveInstanceByPhoneNumberId } from '../src/domain/instances';
import type { Repo } from '../src/repo';

let repo: Repo;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  app = createApp(repo);
});

describe('POST/GET /api/instances', () => {
  it('cria 2 instâncias e lista com token MASCARADO (nunca em texto claro)', async () => {
    const a = await request(app)
      .post('/api/instances')
      .send({
        name: 'Loja A',
        phone_number_id: '111',
        waba_id: 'waba1',
        token: 'SEGREDO_TOKEN_ABCD1234',
        verify_token: 'VERIFY_WXYZ5678',
      })
      .expect(201);
    expect(a.body.provider_type).toBe('meta'); // default
    // Resposta de criação já vem mascarada.
    expect(a.body.token).toBe('••••1234');
    expect(a.body.verify_token).toBe('••••5678');
    expect(a.body.has_token).toBe(true);

    await request(app)
      .post('/api/instances')
      .send({ name: 'Loja B', phone_number_id: '222', token: 'OUTRO_TOKEN_9999' })
      .expect(201);

    const list = await request(app).get('/api/instances').expect(200);
    expect(list.body.length).toBe(2);

    // NENHUM segredo em texto claro em lugar nenhum da resposta.
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain('SEGREDO_TOKEN_ABCD1234');
    expect(raw).not.toContain('VERIFY_WXYZ5678');
    expect(raw).not.toContain('OUTRO_TOKEN_9999');
    for (const inst of list.body) {
      if (inst.token) expect(inst.token.startsWith('••••')).toBe(true);
    }
  });

  it('valida entrada (name obrigatório) → 400', async () => {
    const res = await request(app).post('/api/instances').send({ token: 'x' }).expect(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('PATCH/DELETE /api/instances/:id', () => {
  it('atualiza e deleta', async () => {
    const created = await request(app)
      .post('/api/instances')
      .send({ name: 'X', phone_number_id: '999' })
      .expect(201);
    const id = created.body.id;

    const patched = await request(app)
      .patch(`/api/instances/${id}`)
      .send({ name: 'X2', active: false })
      .expect(200);
    expect(patched.body.name).toBe('X2');
    expect(patched.body.active).toBe(false);

    await request(app).delete(`/api/instances/${id}`).expect(204);
    await request(app).get(`/api/instances/${id}`).expect(404);
  });

  it('PATCH/DELETE em id inexistente → 404', async () => {
    await request(app).patch('/api/instances/nope').send({ name: 'y' }).expect(404);
    await request(app).delete('/api/instances/nope').expect(404);
  });
});

describe('resolvedor por phone_number_id', () => {
  it('resolve a instância correta pelo phone_number_id do payload', async () => {
    const a = await repo.instances.create({
      name: 'A',
      provider_type: 'meta',
      phone_number_id: 'PNID_A',
      waba_id: null,
      token: 't',
      verify_token: 'v',
      active: true,
      connection_status: 'disconnected',
    });
    await repo.instances.create({
      name: 'B',
      provider_type: 'meta',
      phone_number_id: 'PNID_B',
      waba_id: null,
      token: 't',
      verify_token: 'v',
      active: true,
      connection_status: 'disconnected',
    });

    const resolved = await resolveInstanceByPhoneNumberId(repo, 'PNID_A');
    expect(resolved?.id).toBe(a.id);
    expect(resolved?.name).toBe('A');

    // phone_number_id desconhecido → null (não explode).
    expect(await resolveInstanceByPhoneNumberId(repo, 'DESCONHECIDO')).toBeNull();
    expect(await resolveInstanceByPhoneNumberId(repo, '')).toBeNull();
  });
});
