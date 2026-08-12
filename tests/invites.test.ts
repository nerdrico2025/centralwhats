import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { resetEnvCache } from '../src/config';
import { hashInviteToken, newInviteToken } from '../src/util/auth';
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

async function ownerToken(email = 'dono@acme.com') {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ org_name: 'ACME', email, password: SENHA })
    .expect(201);
  return res.body as { token: string; org: { id: string }; user: { id: string } };
}

async function convidar(token: string, email: string, role: 'owner' | 'agent' = 'agent') {
  const res = await request(app)
    .post('/api/invites')
    .set('Authorization', `Bearer ${token}`)
    .send({ email, role })
    .expect(201);
  return res.body as { id: string; token: string; path: string; state: string; role: string };
}

describe('convites — token', () => {
  it('o banco guarda só o HASH; o token em claro não é recuperável', async () => {
    const owner = await ownerToken();
    const inv = await convidar(owner.token, 'novo@acme.com');

    const salvos = await repo.invites.listByOrg(owner.org.id);
    expect(salvos).toHaveLength(1);
    expect(salvos[0].token_hash).toBe(hashInviteToken(inv.token));
    expect(salvos[0].token_hash).not.toBe(inv.token);

    // A listagem da API nunca devolve o hash nem o token.
    const lista = await request(app)
      .get('/api/invites')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(JSON.stringify(lista.body)).not.toContain(inv.token);
    expect(JSON.stringify(lista.body)).not.toContain(salvos[0].token_hash);
  });

  it('token aleatório é de 32 bytes e único', () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(a.token).not.toBe(b.token);
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.hash).toBe(hashInviteToken(a.token));
  });
});

describe('convites — aceite', () => {
  it('prévia pública mostra conta, papel e se o e-mail já tem conta', async () => {
    const owner = await ownerToken();
    const inv = await convidar(owner.token, 'novo@acme.com', 'agent');

    const prev = await request(app).get(`/api/auth/invite/${inv.token}`).expect(200);
    expect(prev.body).toMatchObject({
      org_name: 'ACME',
      email: 'novo@acme.com',
      role: 'agent',
      has_account: false,
    });
  });

  it('USO ÚNICO: o segundo aceite do mesmo token falha', async () => {
    const owner = await ownerToken();
    const inv = await convidar(owner.token, 'novo@acme.com');

    await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.token, password: 'senha-do-convidado-1' })
      .expect(201);

    const segunda = await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.token, password: 'outra-senha-qualquer' })
      .expect(404);
    expect(segunda.body.error).toMatch(/já foi utilizado/i);

    // E o convite ficou marcado como aceito, com o usuário que o consumiu.
    const salvos = await repo.invites.listByOrg(owner.org.id);
    expect(salvos[0].status).toBe('accepted');
    expect(salvos[0].accepted_user_id).toBeTruthy();
  });

  it('o PAPEL vem do convite, nunca do corpo da requisição', async () => {
    const owner = await ownerToken();
    const inv = await convidar(owner.token, 'novo@acme.com', 'agent');

    const aceite = await request(app)
      .post('/api/auth/invite/accept')
      // Tentativa de escalar privilégio no aceite:
      .send({ token: inv.token, password: 'senha-do-convidado-1', role: 'owner' })
      .expect(201);

    expect(aceite.body.user.role).toBe('agent');
    expect(await repo.orgMembers.getRole(owner.org.id, aceite.body.user.id)).toBe('agent');
  });

  it('convite expirado é recusado (expiração é derivada, não gravada)', async () => {
    const owner = await ownerToken();
    const { token, hash } = newInviteToken();
    await repo.invites.create({
      org_id: owner.org.id,
      email: 'atrasado@acme.com',
      role: 'agent',
      token_hash: hash,
      expires_at: new Date(Date.now() - 1000).toISOString(),
      created_by: owner.user.id,
    });

    await request(app).get(`/api/auth/invite/${token}`).expect(404);
    const res = await request(app)
      .post('/api/auth/invite/accept')
      .send({ token, password: 'senha-do-convidado-1' })
      .expect(404);
    expect(res.body.error).toMatch(/expirou/i);
  });

  it('token inexistente → 404 (sem vazar nada)', async () => {
    await ownerToken();
    await request(app).get('/api/auth/invite/token-que-nao-existe').expect(404);
  });

  it('senha curta no aceite → 400 e nada é criado', async () => {
    const owner = await ownerToken();
    const inv = await convidar(owner.token, 'novo@acme.com');
    await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.token, password: 'curta' })
      .expect(400);
    expect(await repo.users.getByEmail('novo@acme.com')).toBeNull();
    expect((await repo.invites.listByOrg(owner.org.id))[0].status).toBe('pending');
  });
});

describe('convites — e-mail que JÁ tem conta (tomada de conta)', () => {
  it('aceitar com senha NOVA não funciona: exige a senha atual do dono do e-mail', async () => {
    // Vítima: usuário existente em outra conta.
    const vitima = await ownerToken('vitima@x.com');
    process.env.PUBLIC_SIGNUP = 'true';
    resetEnvCache();
    const atacante = await ownerToken('atacante@x.com');

    // O atacante convida o e-mail da vítima para a conta dele...
    const inv = await convidar(atacante.token, 'vitima@x.com', 'agent');

    // ...e tenta aceitar o próprio convite definindo uma senha nova.
    await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.token, password: 'senha-do-atacante-1' })
      .expect(401);

    // A senha da vítima continua intacta e a conta dela segue sob controle.
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'vitima@x.com', password: SENHA })
      .expect(200);
    expect(await repo.orgMembers.getRole(atacante.org.id, vitima.user.id)).toBeNull();
  });

  it('a própria pessoa aceita informando a senha atual e ganha o vínculo', async () => {
    const dono = await ownerToken('pessoa@x.com');
    process.env.PUBLIC_SIGNUP = 'true';
    resetEnvCache();
    const outro = await ownerToken('outro@x.com');

    const inv = await convidar(outro.token, 'pessoa@x.com', 'agent');
    const aceite = await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.token, password: SENHA })
      .expect(201);

    expect(aceite.body.user.id).toBe(dono.user.id); // mesmo usuário, não um clone
    expect(await repo.orgMembers.getRole(outro.org.id, dono.user.id)).toBe('agent');
  });
});

describe('convites — gestão pelo owner', () => {
  it('revogar impede o aceite e some da lista de pendentes', async () => {
    const owner = await ownerToken();
    const inv = await convidar(owner.token, 'novo@acme.com');

    await request(app)
      .delete(`/api/invites/${inv.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);

    const res = await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.token, password: 'senha-do-convidado-1' })
      .expect(404);
    expect(res.body.error).toMatch(/cancelado/i);

    const lista = await request(app)
      .get('/api/invites')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(lista.body[0].state).toBe('revoked');
  });

  it('revogar convite inexistente → 404 (nunca finge sucesso)', async () => {
    const owner = await ownerToken();
    await request(app)
      .delete('/api/invites/nao-existe')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(404);
  });

  it('reenviar gera token novo e INVALIDA o anterior', async () => {
    const owner = await ownerToken();
    const inv = await convidar(owner.token, 'novo@acme.com');

    const resend = await request(app)
      .post(`/api/invites/${inv.id}/resend`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(resend.body.token).not.toBe(inv.token);

    await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.token, password: 'senha-do-convidado-1' })
      .expect(404); // link velho morreu
    await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: resend.body.token, password: 'senha-do-convidado-1' })
      .expect(201);
  });

  it('convidar quem já é membro → 409', async () => {
    const owner = await ownerToken();
    const inv = await convidar(owner.token, 'novo@acme.com');
    await request(app)
      .post('/api/auth/invite/accept')
      .send({ token: inv.token, password: 'senha-do-convidado-1' })
      .expect(201);

    await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'novo@acme.com', role: 'agent' })
      .expect(409);
  });

  it('convite de OUTRA conta não é visível nem revogável', async () => {
    const a = await ownerToken('a@a.com');
    process.env.PUBLIC_SIGNUP = 'true';
    resetEnvCache();
    const b = await ownerToken('b@b.com');
    const invA = await convidar(a.token, 'alvo@x.com');

    const listaB = await request(app)
      .get('/api/invites')
      .set('Authorization', `Bearer ${b.token}`)
      .expect(200);
    expect(listaB.body).toEqual([]);

    await request(app)
      .delete(`/api/invites/${invA.id}`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
  });
});
