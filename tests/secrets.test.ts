import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { resetEnvCache } from '../src/config';
import {
  isEncrypted,
  openSecret,
  resetSecretKeyCache,
  sealSecret,
  SecretDecryptError,
} from '../src/util/crypto';
import type { Repo } from '../src/repo';

/**
 * Criptografia de segredos em repouso (P6.1 / L1) e o backfill.
 *
 * O que este arquivo protege: (a) o que sai do adapter é sempre texto claro,
 * (b) o que fica no banco não é, (c) chave errada FALHA ALTO em vez de virar
 * null, e (d) o backfill é idempotente.
 */

const CHAVE = 'chave-de-teste-bem-longa-e-aleatoria-0123456789';
const OUTRA_CHAVE = 'outra-chave-completamente-diferente-9876543210';

function usarChave(v: string | undefined): void {
  if (v === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = v;
  resetEnvCache();
  resetSecretKeyCache();
}

beforeEach(() => usarChave(CHAVE));
afterEach(() => usarChave(undefined));

describe('util/crypto (unitário)', () => {
  it('ida e volta preserva o valor e o formato é enc:v1:', () => {
    const cifrado = sealSecret('EAAG-token-da-meta');
    expect(cifrado).toMatch(/^enc:v1:/);
    expect(cifrado).not.toContain('EAAG-token-da-meta');
    expect(openSecret(cifrado)).toBe('EAAG-token-da-meta');
  });

  it('IV aleatório: o mesmo valor cifra diferente a cada vez', () => {
    expect(sealSecret('igual')).not.toBe(sealSecret('igual'));
  });

  it('IDEMPOTENTE: cifrar de novo devolve o mesmo valor (nunca cifra 2x)', () => {
    const uma = sealSecret('segredo');
    expect(sealSecret(uma)).toBe(uma);
    expect(openSecret(sealSecret(uma))).toBe('segredo');
  });

  it('texto claro LEGADO (sem prefixo) passa direto na leitura', () => {
    expect(openSecret('token-antigo-em-claro')).toBe('token-antigo-em-claro');
    expect(isEncrypted('token-antigo-em-claro')).toBe(false);
  });

  it('null/vazio continuam null/vazio', () => {
    expect(sealSecret(null)).toBeNull();
    expect(sealSecret(undefined)).toBeNull();
    expect(openSecret(null)).toBeNull();
  });

  it('FALHA ALTA: chave errada LANÇA (nunca devolve null em silêncio)', () => {
    const cifrado = sealSecret('segredo');
    usarChave(OUTRA_CHAVE);
    expect(() => openSecret(cifrado)).toThrow(SecretDecryptError);
    expect(() => openSecret(cifrado)).toThrow(/não confere/i);
  });

  it('FALHA ALTA: sem chave, valor cifrado LANÇA com mensagem acionável', () => {
    const cifrado = sealSecret('segredo');
    usarChave(undefined);
    expect(() => openSecret(cifrado)).toThrow(/SECRETS_ENCRYPTION_KEY/);
  });

  it('FALHA ALTA: adulteração é detectada (GCM autenticado)', () => {
    const cifrado = sealSecret('segredo')!;
    const adulterado = cifrado.slice(0, -4) + 'AAAA';
    expect(() => openSecret(adulterado)).toThrow(SecretDecryptError);
  });

  it('versão futura desconhecida LANÇA em vez de adivinhar', () => {
    expect(() => openSecret('enc:v9:qualquer:coisa:aqui')).toThrow(/versão/i);
  });

  it('sem chave configurada (dev), grava em texto claro', () => {
    usarChave(undefined);
    expect(sealSecret('segredo')).toBe('segredo');
  });
});

describe('repo.* cifra na fronteira do adapter', () => {
  let repo: Repo;

  beforeEach(async () => {
    repo = createSqliteAdapter({ path: ':memory:' });
    await repo.migrate();
  });

  it('o domínio só vê texto claro — a cifra é invisível para fora do adapter', async () => {
    const inst = await repo.instances.create({
      org_id: 'org_default',
      name: 'Loja', provider_type: 'meta', phone_number_id: '111', waba_id: null,
      token: 'EAAG-token', verify_token: 'verificacao', active: true,
      connection_status: 'connected',
    });
    expect(inst.token).toBe('EAAG-token');
    expect((await repo.instances.getById(inst.id))?.token).toBe('EAAG-token');
    expect((await repo.instances.list('org_default'))[0].verify_token).toBe('verificacao');
  });

  it('o que ESTÁ no banco é cifrado: outra chave não devolve o segredo', async () => {
    const inst = await repo.instances.create({
      org_id: 'org_default',
      name: 'Loja', provider_type: 'meta', phone_number_id: '111', waba_id: null,
      token: 'EAAG-token', verify_token: null, active: true, connection_status: 'connected',
    });
    // Se estivesse em texto claro, a leitura com outra chave devolveria o valor.
    usarChave(OUTRA_CHAVE);
    const lido = await repo.instances.getById(inst.id);
    // A instância CONTINUA legível como registro (senão o painel cai inteiro),
    // mas o segredo não vaza e a marcação é explícita.
    expect(lido?.token).toBeNull();
    expect(lido?.secrets_unreadable).toBe(true);
  });

  it('update também cifra (token trocado não volta em claro para o banco)', async () => {
    const inst = await repo.instances.create({
      org_id: 'org_default',
      name: 'Loja', provider_type: 'meta', phone_number_id: '111', waba_id: null,
      token: 'antigo', verify_token: null, active: true, connection_status: 'connected',
    });
    await repo.instances.update(inst.id, { token: 'novo-token' });
    expect((await repo.instances.getById(inst.id))?.token).toBe('novo-token');

    usarChave(OUTRA_CHAVE);
    const lido = await repo.instances.getById(inst.id);
    expect(lido?.token).toBeNull();
    expect(lido?.secrets_unreadable).toBe(true);
  });

  it('sessão do Baileys é cifrada e volta idêntica (Buffers preservados)', async () => {
    const inst = await repo.instances.create({
      org_id: 'org_default',
      name: 'Baileys', provider_type: 'baileys', phone_number_id: null, waba_id: null,
      token: null, verify_token: null, active: true, connection_status: 'pending',
    });
    const creds = { me: { id: '5511@s.whatsapp.net' }, chave: [1, 2, 3] };
    await repo.baileysAuth.set(inst.id, 'creds', creds);
    expect(await repo.baileysAuth.get(inst.id, 'creds')).toEqual(creds);

    usarChave(OUTRA_CHAVE);
    await expect(repo.baileysAuth.get(inst.id, 'creds')).rejects.toThrow(SecretDecryptError);
  });
});

describe('backfill de criptografia (npm run encrypt-secrets)', () => {
  let repo: Repo;

  beforeEach(async () => {
    // Nasce SEM chave: é o estado de hoje em produção (tudo em texto claro).
    usarChave(undefined);
    repo = createSqliteAdapter({ path: ':memory:' });
    await repo.migrate();
  });

  it('cifra o legado e é IDEMPOTENTE (rodar 2x não cifra duas vezes)', async () => {
    const inst = await repo.instances.create({
      org_id: 'org_default',
      name: 'Legado', provider_type: 'meta', phone_number_id: '111', waba_id: null,
      token: 'token-em-claro', verify_token: 'verify-em-claro', active: true,
      connection_status: 'connected',
    });
    await repo.baileysAuth.set(inst.id, 'creds', { a: 1 });

    // Deploy do código com a chave: leitura tolerante, nada quebra.
    usarChave(CHAVE);
    expect((await repo.instances.getById(inst.id))?.token).toBe('token-em-claro');

    const primeira = await repo.maintenance.backfillSecretEncryption();
    expect(primeira).toMatchObject({
      instanceTokens: 1,
      instanceVerifyTokens: 1,
      baileysAuthValues: 1,
      skipped: 0,
    });

    // Os dados continuam legíveis pelo sistema...
    const depois = await repo.instances.getById(inst.id);
    expect(depois?.token).toBe('token-em-claro');
    expect(depois?.verify_token).toBe('verify-em-claro');
    expect(await repo.baileysAuth.get(inst.id, 'creds')).toEqual({ a: 1 });

    // ...e a SEGUNDA execução não toca em nada.
    const segunda = await repo.maintenance.backfillSecretEncryption();
    expect(segunda).toMatchObject({
      instanceTokens: 0,
      instanceVerifyTokens: 0,
      baileysAuthValues: 0,
      skipped: 3,
    });
    expect((await repo.instances.getById(inst.id))?.token).toBe('token-em-claro');
  });

  it('depois do backfill, o banco realmente exige a chave certa', async () => {
    const inst = await repo.instances.create({
      org_id: 'org_default',
      name: 'Legado', provider_type: 'meta', phone_number_id: '111', waba_id: null,
      token: 'token-em-claro', verify_token: null, active: true, connection_status: 'connected',
    });
    usarChave(CHAVE);
    await repo.maintenance.backfillSecretEncryption();
    expect((await repo.instances.getById(inst.id))?.token).toBe('token-em-claro');

    // Com a chave errada o segredo não sai — mas o registro segue listável.
    usarChave(OUTRA_CHAVE);
    const lido = await repo.instances.getById(inst.id);
    expect(lido?.token).toBeNull();
    expect(lido?.secrets_unreadable).toBe(true);
  });

  it('instância sem segredo nenhum não conta nada (nem cifra string vazia)', async () => {
    await repo.instances.create({
      org_id: 'org_default',
      name: 'Baileys', provider_type: 'baileys', phone_number_id: null, waba_id: null,
      token: null, verify_token: null, active: true, connection_status: 'disconnected',
    });
    usarChave(CHAVE);
    expect(await repo.maintenance.backfillSecretEncryption()).toMatchObject({
      instanceTokens: 0,
      instanceVerifyTokens: 0,
      baileysAuthValues: 0,
      skipped: 0,
    });
  });
});

describe('chave trocada NÃO pode derrubar o painel (regressão de produção)', () => {
  /**
   * Bug real: com os segredos cifrados por uma chave e o processo web rodando
   * com outra, `GET /api/instances` respondia 500 "Erro interno do servidor" —
   * o painel inteiro ficava inutilizável, inclusive o formulário que permitiria
   * recadastrar o token. E a listagem nem usa o token: ela MASCARA o valor.
   *
   * Regra: listar continua funcionando (com aviso explícito); ENVIAR falha com
   * mensagem específica.
   */
  let repo: Repo;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    usarChave(CHAVE);
    repo = createSqliteAdapter({ path: ':memory:' });
    await repo.migrate();
    app = createApp(repo);
    await repo.instances.create({
      org_id: 'org_default',
      name: 'Jean API', provider_type: 'meta', phone_number_id: '109999888777', waba_id: null,
      token: 'EAAG-token', verify_token: 'verify', active: true, connection_status: 'connected',
    });
  });

  afterEach(() => {
    delete process.env.PUBLIC_SIGNUP;
    resetEnvCache();
  });

  /** Registra o primeiro owner (adota a org_default) e devolve o token. */
  async function logar(): Promise<string> {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ org_name: 'Agência', email: 'rafael@x.com', password: 'senha-de-teste-1' })
      .expect(201);
    expect(reg.body.adopted_default_org).toBe(true);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'rafael@x.com', password: 'senha-de-teste-1' })
      .expect(200);
    return login.body.token as string;
  }

  it('CAMINHO FELIZ: usuário loga e vê a instância da própria org', async () => {
    const token = await logar();
    const res = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.map((i: { name: string }) => i.name)).toEqual(['Jean API']);
    expect(res.body[0].has_token).toBe(true);
    expect(res.body[0].secrets_unreadable).toBe(false);
    expect(res.body[0].token).not.toContain('EAAG'); // segue mascarado
  });

  it('com a chave TROCADA, a listagem responde 200 e marca a instância', async () => {
    const token = await logar();
    usarChave(OUTRA_CHAVE);

    const res = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${token}`)
      .expect(200); // <- era 500
    expect(res.body).toHaveLength(1);
    expect(res.body[0].secrets_unreadable).toBe(true);
    expect(res.body[0].has_token).toBe(false);
  });

  it('ENVIAR por instância ilegível falha com mensagem específica (não "sem token")', async () => {
    const token = await logar();
    usarChave(OUTRA_CHAVE);
    const lista = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const res = await request(app)
      .post(`/api/instances/${lista.body[0].id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'text', to: '5511999998888', text: 'oi' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/SECRETS_ENCRYPTION_KEY/);
  });

  it('recadastrar o token pelo painel recupera a instância', async () => {
    const token = await logar();
    usarChave(OUTRA_CHAVE);
    const lista = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .patch(`/api/instances/${lista.body[0].id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ token: 'EAAG-token-novo', verify_token: 'verify-novo' })
      .expect(200);

    const depois = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(depois.body[0].secrets_unreadable).toBe(false);
    expect(depois.body[0].has_token).toBe(true);
  });
});
