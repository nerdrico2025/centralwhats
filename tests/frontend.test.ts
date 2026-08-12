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

  it('a rota pública de convite cai no SPA (não vira 404 do Express)', async () => {
    // O link do convite é /convite/<token>: se o fallback não pegasse, o
    // convidado veria um 404 em vez da tela de aceite.
    const app = await appWithData();
    const res = await request(app).get('/convite/um-token-qualquer').expect(200);
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

/**
 * Extrai o CÓDIGO de uma função top-level do app.js para testar isolado.
 * app.js é script de browser (sem exports) e o resto dele toca DOM; estas duas
 * funções são puras, então dá para avaliá-las sozinhas.
 */
function extractFn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`função ${name} não encontrada em app.js`);
  let depth = 0;
  let i = source.indexOf('{', start);
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`fim da função ${name} não encontrado (abertura em ${open})`);
}

describe('UI de campanhas — variáveis esperadas pelo template (P3.2)', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'app.js'), 'utf8');
  const expectedTemplateVars = new Function(
    `${extractFn(appJs, 'expectedTemplateVars')}; return expectedTemplateVars;`,
  )() as (t: unknown) => { key: string; label: string; hint?: string; suggested?: string }[];

  /**
   * Template REAL sincronizado da Meta (instância de produção). Se a UI
   * derivar chaves diferentes da convenção de providers/templateComponents.ts,
   * a Meta rejeita o envio por contagem de parâmetros — por isso o formato
   * está travado aqui.
   */
  const templateReal = {
    name: 'confirmacao_cadastro_vaga_vm',
    language: 'pt_BR',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Cadastro confirmado' },
      {
        type: 'BODY',
        text: 'Olá {{1}}, seu cadastro para a vaga de {{2}} foi confirmado.\n\n{{3}}',
        example: {
          body_text: [['Primeiro nome do candidato', 'Cargo da vaga', 'Link de convite do grupo']],
        },
      },
      { type: 'FOOTER', text: 'Vendedor Mestre' },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Entrar no grupo',
            url: 'http://business.facebook.com/{{1}}',
            example: ['https://chat.whatsapp.com/KEQaSkJEpUK8e1XaOFZIoR'],
          },
        ],
      },
    ],
  };

  it('deriva as chaves do BODY e do botão na convenção que o backend espera', () => {
    const slots = expectedTemplateVars(templateReal);
    expect(slots.map((s) => s.key)).toEqual(['1', '2', '3', 'button0']);
    // Header estático não vira variável (não tem placeholder).
    expect(slots.find((s) => s.key === 'header')).toBeUndefined();
  });

  it('mostra ao operador o exemplo da Meta de cada variável', () => {
    const slots = expectedTemplateVars(templateReal);
    expect(slots.find((s) => s.key === '1')!.hint).toBe('Primeiro nome do candidato');
    expect(slots.find((s) => s.key === '3')!.hint).toBe('Link de convite do grupo');
    // {{1}} do corpo já vem sugerido como o nome do contato.
    expect(slots.find((s) => s.key === '1')!.suggested).toBe('name');
  });

  it('header TEXT dinâmico vira a chave reservada "header"', () => {
    const slots = expectedTemplateVars({
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Olá {{1}}', example: { header_text: ['Ana'] } },
        { type: 'BODY', text: 'Corpo sem variável' },
      ],
    });
    expect(slots.map((s) => s.key)).toEqual(['header']);
    expect(slots[0].hint).toBe('Ana');
  });

  it('header de mídia vira "headerMedia"', () => {
    const slots = expectedTemplateVars({
      components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'oi' }],
    });
    expect(slots.map((s) => s.key)).toEqual(['headerMedia']);
  });

  it('vários botões URL viram button0/button1 pela POSIÇÃO', () => {
    const slots = expectedTemplateVars({
      components: [
        { type: 'BODY', text: 'oi' },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Não' },
            { type: 'URL', text: 'A', url: 'https://x.com/{{1}}' },
            { type: 'URL', text: 'B', url: 'https://y.com/{{1}}' },
          ],
        },
      ],
    });
    // O índice é a posição na lista de botões (a Graph API exige assim),
    // não a contagem só dos botões com variável.
    expect(slots.map((s) => s.key)).toEqual(['button1', 'button2']);
  });

  it('template sem variáveis não gera nenhum campo', () => {
    expect(expectedTemplateVars({ components: [{ type: 'BODY', text: 'Sem variável' }] })).toEqual([]);
    expect(expectedTemplateVars({})).toEqual([]);
    expect(expectedTemplateVars(null)).toEqual([]);
  });
});
