import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';

const publicDir = path.join(process.cwd(), 'public');

beforeAll(() => {
  // Gera /public com os assets versionados (idempotente).
  execSync('node scripts/build-web.mjs', { stdio: 'ignore' });
});

async function appWithData() {
  const repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  await repo.instances.create({
    name: 'Loja',
    provider_type: 'meta',
    phone_number_id: '109999888777',
    waba_id: null,
    token: 't',
    verify_token: 'v',
    active: true,
    connection_status: 'connected',
  });
  return createApp(repo);
}

describe('frontend shell', () => {
  it('serve index.html com assets versionados (cache-busting: hash no nome)', async () => {
    const app = await appWithData();
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('WA Manager');
    // Referências com hash de conteúdo no nome.
    expect(res.text).toMatch(/\/app\.[0-9a-f]{10}\.js/);
    expect(res.text).toMatch(/\/styles\.[0-9a-f]{10}\.css/);
  });

  it('o asset versionado é servido e o nome deriva do conteúdo (hash sha256)', async () => {
    const jsFile = fs.readdirSync(publicDir).find((f) => /^app\.[0-9a-f]{10}\.js$/.test(f))!;
    expect(jsFile).toBeDefined();

    const app = await appWithData();
    const res = await request(app).get(`/${jsFile}`).expect(200);
    expect(res.headers['content-type']).toContain('javascript');

    // Prova do cache-busting: o hash no nome é o sha256 (10 chars) do conteúdo.
    const { createHash } = await import('node:crypto');
    const content = fs.readFileSync(path.join(publicDir, jsFile));
    const expected = createHash('sha256').update(content).digest('hex').slice(0, 10);
    expect(jsFile).toBe(`app.${expected}.js`);
  });

  it('fallback do SPA: rota client-side retorna o index.html', async () => {
    const app = await appWithData();
    const res = await request(app).get('/instancias').expect(200);
    expect(res.text).toContain('<div id="app">');
  });

  it('NÃO sombreia a API nem o health', async () => {
    const app = await appWithData();
    const api = await request(app).get('/api/instances').expect(200);
    expect(Array.isArray(api.body)).toBe(true);
    const health = await request(app).get('/health').expect(200);
    expect(health.body.ok).toBe(true);
  });
});
