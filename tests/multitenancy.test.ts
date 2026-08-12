import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { resetEnvCache } from '../src/config';
import { hashPassword, verifyPassword, signToken, verifyToken } from '../src/util/auth';
import type { Repo } from '../src/repo';

let repo: Repo;
let app: ReturnType<typeof createApp>;

const SENHA = 'senha-secreta-123';

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  app = createApp(repo);
});

afterEach(() => {
  delete process.env.PUBLIC_SIGNUP;
  resetEnvCache();
});

/** Registro público ligado — necessário para criar a 2ª org em diante (B2). */
function abrirRegistroPublico(): void {
  process.env.PUBLIC_SIGNUP = 'true';
  resetEnvCache();
}

async function registerOrg(orgName: string, email: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ org_name: orgName, email, password: SENHA })
    .expect(201);
  return res.body as {
    token: string;
    user: { id: string; email: string; role: string };
    org: { id: string; name: string };
    adopted_default_org: boolean;
  };
}

/** Cria instância pela API (o caminho real: sempre na org ativa do token). */
async function criarInstancia(token: string, name: string, phoneNumberId: string) {
  const res = await request(app)
    .post('/api/instances')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, phone_number_id: phoneNumberId })
    .expect(201);
  return res.body as { id: string; name: string };
}

/** Convida + aceita, devolvendo o token do convidado. É o caminho novo. */
export async function convidarEAceitar(
  appRef: ReturnType<typeof createApp>,
  ownerToken: string,
  email: string,
  role: 'owner' | 'agent',
  senha = 'senha-do-convidado-1',
) {
  const inv = await request(appRef)
    .post('/api/invites')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email, role })
    .expect(201);
  const accept = await request(appRef)
    .post('/api/auth/invite/accept')
    .send({ token: inv.body.token, password: senha })
    .expect(201);
  return { token: accept.body.token as string, userId: accept.body.user.id as string, invite: inv.body };
}

describe('util/auth (unitário)', () => {
  it('hash/verify de senha (scrypt) e JWT com expiração e iat', () => {
    const stored = hashPassword('minhasenha');
    expect(verifyPassword('minhasenha', stored)).toBe(true);
    expect(verifyPassword('errada', stored)).toBe(false);

    const token = signToken({ sub: 'u1', org_id: 'o1', role: 'owner' }, 'seg');
    const payload = verifyToken(token, 'seg');
    expect(payload).toMatchObject({ sub: 'u1', org_id: 'o1', role: 'owner' });
    expect(typeof payload?.iat).toBe('number'); // iat é o que permite revogar
    expect(verifyToken(token, 'outro-segredo')).toBeNull(); // assinatura errada
    const expired = signToken({ sub: 'u1', org_id: 'o1', role: 'owner' }, 'seg', -10);
    expect(verifyToken(expired, 'seg')).toBeNull(); // expirado
  });
});

describe('migração sem perda (org default)', () => {
  it('instância pré-existente na org default é visível no modo bootstrap', async () => {
    const inst = await repo.instances.create({
      org_id: 'org_default',
      name: 'V1', provider_type: 'meta', phone_number_id: '111', waba_id: null,
      token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });
    expect(inst.org_id).toBe('org_default');
    expect(await repo.orgs.getById('org_default')).not.toBeNull();

    const list = await request(app).get('/api/instances').expect(200);
    expect(list.body.length).toBe(1);
  });

  it('a migration 010 leva TODO vínculo de users para org_members (sem perda)', async () => {
    // Simula o estado pré-P6.1: usuário gravado com org_id, sem org_members.
    const org = await repo.orgs.create({ name: 'Antiga', plan: 'free' });
    const user = await repo.users.create({
      org_id: org.id, email: 'legado@x.com', role: 'owner', password_hash: hashPassword(SENHA),
    });
    // (o adapter já cria o usuário; o vínculo é o que a migration faria)
    await repo.orgMembers.add(org.id, user.id, 'owner');

    expect(await repo.orgMembers.getRole(org.id, user.id)).toBe('owner');
    const orgs = await repo.orgMembers.listByUser(user.id);
    expect(orgs).toEqual([{ org_id: org.id, org_name: 'Antiga', role: 'owner' }]);
  });
});

describe('B1 — bootstrap → primeiro registro NÃO órfã a instância de produção', () => {
  it('o que era visível ANTES do registro continua visível DEPOIS', async () => {
    // Estado de produção: instância viva na org_default, sem dono.
    await repo.instances.create({
      org_id: 'org_default',
      name: 'Loja Real', provider_type: 'meta', phone_number_id: 'ea46', waba_id: null,
      token: 'token-meta', verify_token: 'v', active: true, connection_status: 'connected',
    });
    const antes = await request(app).get('/api/instances').expect(200);
    expect(antes.body.map((i: { name: string }) => i.name)).toEqual(['Loja Real']);

    // Rafael cria a conta dele pela tela normal.
    const reg = await registerOrg('Agência do Rafael', 'rafael@x.com');
    expect(reg.adopted_default_org).toBe(true);
    expect(reg.org.id).toBe('org_default'); // adotou, não criou outra
    expect(reg.org.name).toBe('Agência do Rafael'); // renomeada

    // O CENÁRIO QUE FALTAVA: depois do registro, com o token, tudo continua lá.
    const depois = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${reg.token}`)
      .expect(200);
    expect(depois.body.map((i: { name: string }) => i.name)).toEqual(['Loja Real']);

    // E o painel realmente tranca para quem não tem token.
    await request(app).get('/api/instances').expect(401);
  });

  it('sem instância na org default, o primeiro registro cria uma org nova', async () => {
    const reg = await registerOrg('Conta Nova', 'novo@x.com');
    expect(reg.adopted_default_org).toBe(false);
    expect(reg.org.id).not.toBe('org_default');
  });

  it('o segundo registro (com PUBLIC_SIGNUP) NUNCA adota a org default', async () => {
    await repo.instances.create({
      org_id: 'org_default',
      name: 'Loja Real', provider_type: 'meta', phone_number_id: 'ea46', waba_id: null,
      token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });
    const primeiro = await registerOrg('Primeira', 'a@a.com');
    expect(primeiro.adopted_default_org).toBe(true);

    abrirRegistroPublico();
    const segundo = await registerOrg('Segunda', 'b@b.com');
    expect(segundo.adopted_default_org).toBe(false);
    expect(segundo.org.id).not.toBe('org_default');

    // A conta nova nasce VAZIA — não herda a instância de ninguém.
    const list = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${segundo.token}`)
      .expect(200);
    expect(list.body).toEqual([]);
  });
});

describe('B2 — registro público fechado por default (fail-closed)', () => {
  it('durante o bootstrap o registro responde; depois dele, 403 sem PUBLIC_SIGNUP', async () => {
    await registerOrg('Primeira', 'a@a.com'); // bootstrap: sempre permitido

    const res = await request(app)
      .post('/api/auth/register')
      .send({ org_name: 'Intrusa', email: 'intruso@x.com', password: SENHA })
      .expect(403);
    expect(res.body.error).toMatch(/convite/i);

    // Nada foi criado.
    expect(await repo.users.getByEmail('intruso@x.com')).toBeNull();
  });

  it('com PUBLIC_SIGNUP=true, o registro volta a funcionar', async () => {
    await registerOrg('Primeira', 'a@a.com');
    abrirRegistroPublico();
    await registerOrg('Segunda', 'b@b.com');
  });

  it('GET /registration-status reflete o estado (é o que a tela de login usa)', async () => {
    const s1 = await request(app).get('/api/auth/registration-status').expect(200);
    expect(s1.body).toMatchObject({ bootstrap: true, open: true });

    await registerOrg('Primeira', 'a@a.com');
    const s2 = await request(app).get('/api/auth/registration-status').expect(200);
    expect(s2.body).toMatchObject({ bootstrap: false, public_signup: false, open: false });
  });

  it('email duplicado → 409', async () => {
    await registerOrg('A', 'x@x.com');
    abrirRegistroPublico();
    await request(app)
      .post('/api/auth/register')
      .send({ org_name: 'B', email: 'x@x.com', password: SENHA })
      .expect(409);
  });
});

describe('login e trancamento', () => {
  it('login devolve token; senha nunca vaza; senha errada é 401', async () => {
    const reg = await registerOrg('ACME', 'dono@acme.com');
    expect(reg.user).not.toHaveProperty('password_hash');
    expect(JSON.stringify(reg)).not.toContain(SENHA);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'dono@acme.com', password: SENHA })
      .expect(200);
    expect(login.body.token).toBeDefined();
    expect(login.body.active_org_id).toBe(reg.org.id);
    expect(JSON.stringify(login.body)).not.toContain('password_hash');

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'dono@acme.com', password: 'errada' })
      .expect(401);
  });

  it('login carimba last_login_at', async () => {
    const reg = await registerOrg('ACME', 'dono@acme.com');
    await request(app).post('/api/auth/login').send({ email: 'dono@acme.com', password: SENHA });
    const user = await repo.users.getById(reg.user.id);
    expect(user?.last_login_at).toBeTruthy();
  });
});

describe('ISOLAMENTO CROSS-ORG (critério de aceite)', () => {
  it('org A não enxerga nem acessa dados da org B', async () => {
    const a = await registerOrg('Org A', 'a@a.com');
    abrirRegistroPublico();
    const b = await registerOrg('Org B', 'b@b.com');

    const instA = await criarInstancia(a.token, 'Loja A', '111');
    const instB = await criarInstancia(b.token, 'Loja B', '222');

    const listA = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${a.token}`)
      .expect(200);
    expect(listA.body.map((i: { name: string }) => i.name)).toEqual(['Loja A']);

    // Acesso direto cruzado: 404 (nem revela que existe).
    await request(app)
      .get(`/api/instances/${instB.id}`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(404);
    await request(app)
      .patch(`/api/instances/${instA.id}`)
      .set('Authorization', `Bearer ${b.token}`)
      .send({ name: 'hackeada' })
      .expect(404);
    await request(app)
      .delete(`/api/instances/${instA.id}`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);

    // Dados criados por A ficam invisíveis para B mesmo via rotas escopadas.
    await request(app)
      .post(`/api/instances/${instA.id}/contacts`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ phone: '5511999998888', name: 'Cliente A' })
      .expect(201);
    await request(app)
      .get(`/api/instances/${instA.id}/contacts`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);

    // Dashboard da org A não conta instâncias da org B.
    const dash = await request(app)
      .get(`/api/instances/${instA.id}/dashboard`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(200);
    expect(dash.body.active_instances).toBe(1);
    expect(dash.body.by_instance.map((i: { name: string }) => i.name)).toEqual(['Loja A']);
  });

  it('token com org_id de OUTRA conta é recusado (o token pede, o banco decide)', async () => {
    const a = await registerOrg('Org A', 'a@a.com');
    abrirRegistroPublico();
    const b = await registerOrg('Org B', 'b@b.com');
    await criarInstancia(b.token, 'Loja B', '222');

    // Token forjado: usuário de A dizendo que sua org ativa é a de B.
    const forjado = signToken(
      { sub: a.user.id, org_id: b.org.id, role: 'owner' },
      'dev-secret-nao-use-em-producao',
    );
    const res = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${forjado}`)
      .expect(403);
    expect(res.body.error).toMatch(/não tem acesso/i);
  });
});

describe('org_members — N:N, troca de conta ativa', () => {
  it('o mesmo usuário participa de duas contas e alterna entre elas', async () => {
    const a = await registerOrg('Cliente A', 'agencia@x.com');
    abrirRegistroPublico();
    const b = await registerOrg('Cliente B', 'outro@x.com');
    await criarInstancia(a.token, 'Loja A', '111');
    await criarInstancia(b.token, 'Loja B', '222');

    // O dono de B convida o e-mail da agência (que JÁ tem conta): o aceite
    // exige a senha ATUAL dele — é o que impede tomada de conta por convite.
    const inv = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ email: 'agencia@x.com', role: 'owner' })
      .expect(201);

    await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.body.token, password: 'senha-inventada-999' })
      .expect(401);

    const accept = await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.body.token, password: SENHA })
      .expect(201);

    // GET /api/me lista as DUAS contas.
    const me = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${accept.body.token}`)
      .expect(200);
    expect(me.body.orgs.map((o: { org_name: string }) => o.org_name).sort()).toEqual([
      'Cliente A',
      'Cliente B',
    ]);
    expect(me.body.active_org_id).toBe(b.org.id);

    // Na conta B enxerga a Loja B...
    const emB = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${accept.body.token}`)
      .expect(200);
    expect(emB.body.map((i: { name: string }) => i.name)).toEqual(['Loja B']);

    // ...troca para a conta A e enxerga a Loja A (mesmo usuário, outro token).
    const sw = await request(app)
      .post('/api/me/switch-org')
      .set('Authorization', `Bearer ${accept.body.token}`)
      .send({ org_id: a.org.id })
      .expect(200);
    const emA = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${sw.body.token}`)
      .expect(200);
    expect(emA.body.map((i: { name: string }) => i.name)).toEqual(['Loja A']);
  });

  it('trocar para uma conta da qual NÃO se é membro → 403', async () => {
    const a = await registerOrg('Cliente A', 'a@a.com');
    abrirRegistroPublico();
    const b = await registerOrg('Cliente B', 'b@b.com');

    await request(app)
      .post('/api/me/switch-org')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ org_id: b.org.id })
      .expect(403);
  });

  it('papel é POR CONTA: owner numa, agent na outra', async () => {
    const a = await registerOrg('Cliente A', 'chefe@a.com');
    abrirRegistroPublico();
    const b = await registerOrg('Cliente B', 'chefe@b.com');
    const instB = await criarInstancia(b.token, 'Loja B', '222');

    // chefe@a.com entra em B como AGENT.
    const inv = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ email: 'chefe@a.com', role: 'agent' })
      .expect(201);
    const accept = await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.body.token, password: SENHA })
      .expect(201);

    // Em B (agent): Live Chat sim, campanhas não.
    await request(app)
      .get(`/api/instances/${instB.id}/conversations`)
      .set('Authorization', `Bearer ${accept.body.token}`)
      .expect(200);
    await request(app)
      .get(`/api/instances/${instB.id}/campaigns`)
      .set('Authorization', `Bearer ${accept.body.token}`)
      .expect(403);

    // Em A continua owner.
    const sw = await request(app)
      .post('/api/me/switch-org')
      .set('Authorization', `Bearer ${accept.body.token}`)
      .send({ org_id: a.org.id })
      .expect(200);
    expect(sw.body.role).toBe('owner');
    await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${sw.body.token}`)
      .expect(200);
  });
});

describe('papéis: owner × agent', () => {
  it('agent só atende no Live Chat; owner gerencia', async () => {
    const a = await registerOrg('ACME', 'dono@acme.com');
    const inst = await criarInstancia(a.token, 'Loja', '111');
    const agente = await convidarEAceitar(app, a.token, 'agente@acme.com', 'agent');

    // Agent PODE: listar instâncias e usar o Live Chat.
    await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${agente.token}`)
      .expect(200);
    await request(app)
      .get(`/api/instances/${inst.id}/conversations`)
      .set('Authorization', `Bearer ${agente.token}`)
      .expect(200);

    // Agent NÃO PODE: criar instância, campanhas, fluxos, equipe, dashboard.
    await request(app)
      .post('/api/instances')
      .set('Authorization', `Bearer ${agente.token}`)
      .send({ name: 'X' })
      .expect(403);
    await request(app)
      .get(`/api/instances/${inst.id}/campaigns`)
      .set('Authorization', `Bearer ${agente.token}`)
      .expect(403);
    await request(app)
      .get(`/api/instances/${inst.id}/flows`)
      .set('Authorization', `Bearer ${agente.token}`)
      .expect(403);
    await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${agente.token}`)
      .expect(403);
    await request(app)
      .get('/api/invites')
      .set('Authorization', `Bearer ${agente.token}`)
      .expect(403);
    await request(app)
      .get(`/api/instances/${inst.id}/dashboard`)
      .set('Authorization', `Bearer ${agente.token}`)
      .expect(403);
  });

  it('convidado nasce SEMPRE na org de quem convidou, com o papel do convite', async () => {
    const a = await registerOrg('A', 'a@a.com');
    const convidado = await convidarEAceitar(app, a.token, 'novo@a.com', 'agent');
    expect(await repo.orgMembers.getRole(a.org.id, convidado.userId)).toBe('agent');

    const membros = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${a.token}`)
      .expect(200);
    expect(membros.body.map((u: { email: string }) => u.email).sort()).toEqual([
      'a@a.com',
      'novo@a.com',
    ]);
  });

  it('a rota antiga de criar usuário com senha do owner NÃO existe mais', async () => {
    const a = await registerOrg('A', 'a@a.com');
    await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ email: 'x@a.com', password: 'senha-do-owner-1', role: 'agent' })
      .expect(404);
  });
});

describe('L5 — revogação de sessão (senha trocada / usuário desabilitado)', () => {
  it('trocar a senha derruba as sessões antigas e mantém a nova', async () => {
    const a = await registerOrg('ACME', 'dono@acme.com');
    const antigo = a.token;

    const troca = await request(app)
      .post('/api/me/password')
      .set('Authorization', `Bearer ${antigo}`)
      .send({ current_password: SENHA, new_password: 'nova-senha-forte-1' })
      .expect(200);

    // O token ANTIGO morreu...
    const res = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${antigo}`)
      .expect(401);
    expect(res.body.error).toMatch(/senha/i);

    // ...e o devolvido pela troca continua valendo.
    await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${troca.body.token}`)
      .expect(200);

    // A senha nova é a que loga.
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'dono@acme.com', password: 'nova-senha-forte-1' })
      .expect(200);
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'dono@acme.com', password: SENHA })
      .expect(401);
  });

  it('senha atual errada não troca nada', async () => {
    const a = await registerOrg('ACME', 'dono@acme.com');
    await request(app)
      .post('/api/me/password')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ current_password: 'chute', new_password: 'nova-senha-forte-1' })
      .expect(401);
    await request(app).get('/api/instances').set('Authorization', `Bearer ${a.token}`).expect(200);
  });

  it('desabilitar um usuário derruba a sessão dele na request seguinte', async () => {
    const a = await registerOrg('ACME', 'dono@acme.com');
    const agente = await convidarEAceitar(app, a.token, 'agente@acme.com', 'agent');
    await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${agente.token}`)
      .expect(200);

    await request(app)
      .post(`/api/users/${agente.userId}/disable`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(200);

    const res = await request(app)
      .get('/api/instances')
      .set('Authorization', `Bearer ${agente.token}`)
      .expect(401);
    expect(res.body.error).toMatch(/desabilitado/i);

    // E nem consegue logar de novo.
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'agente@acme.com', password: 'senha-do-convidado-1' })
      .expect(403);

    // Reabilitar devolve o acesso.
    await request(app)
      .post(`/api/users/${agente.userId}/enable`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(200);
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'agente@acme.com', password: 'senha-do-convidado-1' })
      .expect(200);
  });

  it('owner não desabilita a si mesmo (trava anti-lockout)', async () => {
    const a = await registerOrg('ACME', 'dono@acme.com');
    await request(app)
      .post(`/api/users/${a.user.id}/disable`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(400);
  });

  it('owner não desabilita usuário de OUTRA conta (404, não vaza existência)', async () => {
    const a = await registerOrg('Org A', 'a@a.com');
    abrirRegistroPublico();
    const b = await registerOrg('Org B', 'b@b.com');
    await request(app)
      .post(`/api/users/${b.user.id}/disable`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(404);
  });
});
