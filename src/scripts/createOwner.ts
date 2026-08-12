import { getRepo } from '../repo';
import { hashPassword } from '../util/auth';

/* eslint-disable no-console */

/**
 * `npm run create-owner` — cria (ou promove) um OWNER numa conta, pela linha
 * de comando. É a ferramenta de recuperação do B1: quando alguém já registrou
 * a primeira conta antes da correção, a instância de produção ficou na
 * `org_default` sem dono nenhum e não há tela capaz de consertar isso.
 *
 * Serve também para criar o primeiro usuário de qualquer ambiente novo sem
 * depender do navegador.
 *
 * Uso:
 *   npm run create-owner -- --email=rafael@x.com --password='...' \
 *     [--name='Rafael'] [--org=org_default] [--org-name='Minha Agência']
 *
 * Sem --org: adota a `org_default` se ela existir (o caso do B1); senão cria
 * uma org nova com --org-name.
 *
 * Se o e-mail JÁ tiver usuário, o script não recria nem troca a senha — só
 * garante o vínculo de owner naquela conta.
 */

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(raw);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const email = (args.email ?? '').trim().toLowerCase();
  const password = args.password ?? '';

  if (!email || !password) {
    throw new Error(
      'Uso: npm run create-owner -- --email=<e-mail> --password=<senha> ' +
        "[--name='Nome'] [--org=<org_id>] [--org-name='Nome da conta']",
    );
  }
  if (password.length < 8) {
    throw new Error('A senha precisa ter no mínimo 8 caracteres.');
  }

  const repo = getRepo();
  console.log(`Banco: ${repo.driver} @ ${repo.target}`);
  await repo.migrate();

  // ---------------------------------------------------------------- a conta
  let org = args.org ? await repo.orgs.getById(args.org) : await repo.orgs.getById('org_default');
  if (args.org && !org) {
    // Org explícita que não existe é ERRO: criar uma "parecida" em silêncio é
    // como se perde o vínculo com as instâncias que já estão lá.
    throw new Error(`Org "${args.org}" não encontrada. Confira o id (SELECT id, name FROM orgs).`);
  }
  if (!org) {
    const name = args['org-name'] ?? 'Minha conta';
    org = await repo.orgs.create({ name, plan: 'free' });
    console.log(`Org criada: ${org.id} ("${org.name}")`);
  } else {
    if (args['org-name'] && args['org-name'] !== org.name) {
      org = (await repo.orgs.rename(org.id, args['org-name'])) ?? org;
    }
    const instances = await repo.orgs.countInstances(org.id);
    console.log(`Org alvo: ${org.id} ("${org.name}") — ${instances} instância(s)`);
  }

  // ------------------------------------------------------------- o usuário
  const existing = await repo.users.getByEmail(email);
  const user =
    existing ??
    (await repo.users.create({
      org_id: org.id,
      email,
      name: args.name ?? null,
      role: 'owner',
      password_hash: hashPassword(password),
    }));

  if (existing) {
    console.log(`Usuário ${email} já existia (${user.id}) — a senha NÃO foi alterada.`);
  } else {
    console.log(`Usuário criado: ${user.id} (${email})`);
  }

  await repo.orgMembers.add(org.id, user.id, 'owner');
  console.log(`Vínculo garantido: ${email} é OWNER de "${org.name}".`);

  const orgs = await repo.orgMembers.listByUser(user.id);
  console.log(`Contas deste usuário: ${orgs.map((o) => `${o.org_name} (${o.role})`).join(', ')}`);

  await repo.close();
  console.log('Pronto. Entre no painel com esse e-mail e senha.');
}

main().catch((err) => {
  console.error('FALHA ao criar o owner:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
