import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { resetEnvCache } from '../src/config';
import { hashApiKey, API_KEY_PREFIX } from '../src/util/auth';
import { rotaPermitida, ROTAS_PERMITIDAS } from '../src/http/apiKeyAuth';
import type { Repo } from '../src/repo';
import type { Provider } from '../src/providers/types';

/**
 * CHAVES DE API DE SERVIÇO (P6.3).
 *
 * O que estes testes protegem, em ordem de gravidade: uma chave nunca alcança
 * outra org; nunca alcança rota fora da lista branca; revogada não vale; e o
 * login por JWT continua exatamente como era.
 */

let repo: Repo;
let app: ReturnType<typeof createApp>;

const SENHA = 'senha-secreta-123';

/** Provider fake: nenhum teste aqui pode falar com a Meta de verdade. */
const providerFake = (): Provider =>
  ({
    type: 'meta',
    capabilities: {
      text: true, media: true, template: true,
      buttons: true, list: true, reaction: true, cta: true,
    },
    async sendText() {
      return { waMessageId: 'wamid.TESTE', status: 'sent' as const };
    },
    async sendTemplate() {
      return { waMessageId: 'wamid.TEMPLATE', status: 'sent' as const };
    },
  }) as unknown as Provider;

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  app = createApp(repo, { providerFor: providerFake });
});

afterEach(() => {
  delete process.env.PUBLIC_SIGNUP;
  resetEnvCache();
});

async function registrarOrg(orgName: string, email: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ org_name: orgName, email, password: SENHA })
    .expect(201);
  return res.body as { token: string; org: { id: string } };
}

async function criarInstancia(token: string, name: string, phoneNumberId: string) {
  const res = await request(app)
    .post('/api/instances')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, phone_number_id: phoneNumberId, token: 'tok', verify_token: 'vt' })
    .expect(201);
  return res.body as { id: string };
}

async function criarChave(
  token: string,
  instanceId: string,
  body: Record<string, unknown> = { label: 'Recrutador - produção' },
) {
  const res = await request(app)
    .post(`/api/instances/${instanceId}/api-keys`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(201);
  return res.body as { id: string; key: string; instance_id: string | null };
}

const ENVIO = { type: 'text', to: '5511999998888', text: 'oi' };

describe('criação da chave', () => {
  it('devolve o valor em claro UMA vez e guarda só o hash', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    const inst = await criarInstancia(a.token, 'Loja A', '5511000000001');
    const chave = await criarChave(a.token, inst.id);

    expect(chave.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(chave.instance_id).toBe(inst.id); // scope_instance default = true

    // No banco: o hash, e nada que se pareça com a chave.
    const noBanco = await repo.apiKeys.getByKeyHash(hashApiKey(chave.key));
    expect(noBanco?.id).toBe(chave.id);
    expect(noBanco?.key_hash).toBe(hashApiKey(chave.key));
    expect(JSON.stringify(noBanco)).not.toContain(chave.key);

    // A listagem NUNCA repete o valor em claro (nem o hash).
    const lista = await request(app)
      .get(`/api/instances/${inst.id}/api-keys`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(200);
    expect(lista.body).toHaveLength(1);
    expect(JSON.stringify(lista.body)).not.toContain(chave.key);
    expect(lista.body[0].key_hash).toBeUndefined();
    expect(lista.body[0].active).toBe(true);
  });

  it('só owner cria chave; agent toma 403', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    const inst = await criarInstancia(a.token, 'Loja A', '5511000000001');
    const inv = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ email: 'agente@a.com', role: 'agent' })
      .expect(201);
    const agente = await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.body.token, password: 'senha-do-agente-1' })
      .expect(201);

    await request(app)
      .post(`/api/instances/${inst.id}/api-keys`)
      .set('Authorization', `Bearer ${agente.body.token}`)
      .send({ label: 'não deveria' })
      .expect(403);
  });
});

describe('autenticação por chave', () => {
  it('chave válida envia mensagem na instância dela', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    const inst = await criarInstancia(a.token, 'Loja A', '5511000000001');
    const chave = await criarChave(a.token, inst.id);

    const res = await request(app)
      .post(`/api/instances/${inst.id}/messages`)
      .set('Authorization', `Bearer ${chave.key}`)
      .send(ENVIO)
      .expect(201);

    expect(res.body.wa_message_id).toBe('wamid.TESTE');
    expect(res.body.status).toBe('sent');
  });

  it('chave de uma org NÃO alcança instância de outra org (404, sem vazar)', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    process.env.PUBLIC_SIGNUP = 'true';
    resetEnvCache();
    const b = await registrarOrg('Org B', 'b@b.com');

    const instA = await criarInstancia(a.token, 'Loja A', '5511000000001');
    const instB = await criarInstancia(b.token, 'Loja B', '5511000000002');
    // Chave de org inteira (o caso mais permissivo que existe) — ainda assim
    // não pode enxergar a instância da outra conta.
    const chaveA = await criarChave(a.token, instA.id, {
      label: 'org inteira',
      scope_instance: false,
    });
    expect(chaveA.instance_id).toBeNull();

    const res = await request(app)
      .post(`/api/instances/${instB.id}/messages`)
      .set('Authorization', `Bearer ${chaveA.key}`)
      .send(ENVIO);

    expect(res.status).toBe(404); // não 403: não revela que a instância existe
    expect(JSON.stringify(res.body)).not.toContain('Loja B');
  });

  it('chave presa a UMA instância não alcança outra da MESMA org', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    const inst1 = await criarInstancia(a.token, 'Loja 1', '5511000000001');
    const inst2 = await criarInstancia(a.token, 'Loja 2', '5511000000002');
    const chave = await criarChave(a.token, inst1.id); // presa à inst1

    await request(app)
      .post(`/api/instances/${inst2.id}/messages`)
      .set('Authorization', `Bearer ${chave.key}`)
      .send(ENVIO)
      .expect(404);

    // E a de org inteira, essa sim, alcança as duas.
    const orgKey = await criarChave(a.token, inst1.id, {
      label: 'org inteira',
      scope_instance: false,
    });
    await request(app)
      .post(`/api/instances/${inst2.id}/messages`)
      .set('Authorization', `Bearer ${orgKey.key}`)
      .send(ENVIO)
      .expect(201);
  });

  it('chave revogada é rejeitada (401) e a linha NÃO some', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    const inst = await criarInstancia(a.token, 'Loja A', '5511000000001');
    const chave = await criarChave(a.token, inst.id);

    await request(app)
      .post(`/api/instances/${inst.id}/api-keys/${chave.id}/revoke`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(204);

    await request(app)
      .post(`/api/instances/${inst.id}/messages`)
      .set('Authorization', `Bearer ${chave.key}`)
      .send(ENVIO)
      .expect(401);

    // Soft revoke: o histórico continua explicando o que a chave fez.
    const lista = await request(app)
      .get(`/api/instances/${inst.id}/api-keys`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(200);
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0].active).toBe(false);
    expect(lista.body[0].revoked_at).toBeTruthy();

    // Revogar de novo não mente dizendo que revogou.
    await request(app)
      .post(`/api/instances/${inst.id}/api-keys/${chave.id}/revoke`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(404);
  });

  it('chave inexistente ou malformada é rejeitada (401)', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    const inst = await criarInstancia(a.token, 'Loja A', '5511000000001');

    for (const bruta of [
      `${API_KEY_PREFIX}naoexiste`,
      `${API_KEY_PREFIX}`,
      `${API_KEY_PREFIX}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    ]) {
      await request(app)
        .post(`/api/instances/${inst.id}/messages`)
        .set('Authorization', `Bearer ${bruta}`)
        .send(ENVIO)
        .expect(401);
    }
  });

  it('last_used_at é gravado após uso bem-sucedido (e não antes)', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    const inst = await criarInstancia(a.token, 'Loja A', '5511000000001');
    const chave = await criarChave(a.token, inst.id);

    const antes = await repo.apiKeys.getByKeyHash(hashApiKey(chave.key));
    expect(antes?.last_used_at).toBeNull();

    await request(app)
      .post(`/api/instances/${inst.id}/messages`)
      .set('Authorization', `Bearer ${chave.key}`)
      .send(ENVIO)
      .expect(201);

    // O carimbo é best-effort e fora do caminho da resposta: espera o tick.
    await new Promise((r) => setTimeout(r, 20));
    const depois = await repo.apiKeys.getByKeyHash(hashApiKey(chave.key));
    expect(depois?.last_used_at).toBeTruthy();
  });
});

describe('lista branca de rotas (deny-by-default)', () => {
  it('rotaPermitida casa só o que está liberado', () => {
    expect(rotaPermitida('POST', '/instances/abc/messages')?.instanceId).toBe('abc');
    // Papel mínimo por rota: enviar não exige owner.
    expect(rotaPermitida('POST', '/instances/abc/messages')?.rota.role).toBe('agent');

    expect(rotaPermitida('GET', '/instances/abc/messages')).toBeNull(); // verbo errado
    expect(rotaPermitida('GET', '/instances/abc/templates')).toBeNull(); // ownerOnly: fora
    expect(rotaPermitida('POST', '/instances/abc/campaigns')).toBeNull();
    expect(rotaPermitida('POST', '/instances/abc/contacts')).toBeNull();
    expect(rotaPermitida('POST', '/instances/abc/messages/extra')).toBeNull();
    expect(rotaPermitida('GET', '/instances')).toBeNull();
  });

  it('INVARIANTE: nenhuma rota liberada concede owner à chave de serviço', () => {
    // Trava a decisão de privilégio mínimo absoluto. Liberar uma rota
    // ownerOnly (como GET /templates era) quebra este teste antes do deploy.
    expect(ROTAS_PERMITIDAS.length).toBeGreaterThan(0);
    for (const rota of ROTAS_PERMITIDAS) {
      expect(rota.role, `rota "${rota.descricao}" não pode conceder owner`).toBe('agent');
    }
  });

  it('rota administrativa com chave válida é 403, mesmo na instância certa', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    const inst = await criarInstancia(a.token, 'Loja A', '5511000000001');
    const chave = await criarChave(a.token, inst.id);

    for (const caminho of ['campaigns', 'contacts', 'crm', 'lists', 'flows', 'api-keys']) {
      const res = await request(app)
        .post(`/api/instances/${inst.id}/${caminho}`)
        .set('Authorization', `Bearer ${chave.key}`)
        .send({});
      expect(res.status, `POST ${caminho} com API key`).toBe(403);
    }

    // Templates é ownerOnly e ficou FORA da lista branca (privilégio mínimo
    // absoluto): a chave leva o mesmo 403 das demais rotas de gestão. Quem
    // envia descobre template não sincronizado pelo 400 do próprio envio.
    await request(app)
      .get(`/api/instances/${inst.id}/templates`)
      .set('Authorization', `Bearer ${chave.key}`)
      .expect(403);
  });

  it('chave não escala privilégio: não lista nem cria outras chaves', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    const inst = await criarInstancia(a.token, 'Loja A', '5511000000001');
    const chave = await criarChave(a.token, inst.id);

    await request(app)
      .get(`/api/instances/${inst.id}/api-keys`)
      .set('Authorization', `Bearer ${chave.key}`)
      .expect(403);
  });
});

describe('não-regressão do login por JWT', () => {
  it('JWT de usuário continua funcionando igual', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    const inst = await criarInstancia(a.token, 'Loja A', '5511000000001');

    // Rota administrativa: só o JWT passa.
    await request(app)
      .get(`/api/instances/${inst.id}/campaigns`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(200);

    // Envio: o mesmo JWT continua enviando.
    await request(app)
      .post(`/api/instances/${inst.id}/messages`)
      .set('Authorization', `Bearer ${a.token}`)
      .send(ENVIO)
      .expect(201);

    // Login normal segue emitindo token válido.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@a.com', password: SENHA })
      .expect(200);
    await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200);
  });

  it('token inválido SEM o prefixo continua caindo no erro de JWT (não no de chave)', async () => {
    const a = await registrarOrg('Org A', 'a@a.com');
    const inst = await criarInstancia(a.token, 'Loja A', '5511000000001');

    const res = await request(app)
      .post(`/api/instances/${inst.id}/messages`)
      .set('Authorization', 'Bearer token-qualquer-invalido')
      .send(ENVIO);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/token/i); // mensagem do fluxo de JWT
  });
});
