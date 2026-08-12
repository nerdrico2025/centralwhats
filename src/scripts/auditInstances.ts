import { getRepo } from '../repo';

/* eslint-disable no-console */

/**
 * `npm run audit-instances` — auditoria PRÉ-migration 012.
 *
 * A 012 torna instances.org_id NOT NULL com FK para orgs. Se houver instância
 * sem org, ou apontando para uma org que não existe, a migration falha (de
 * propósito). Este script mostra o problema ANTES, com os ids na mão, em vez
 * de deixar você descobrir no meio do deploy.
 *
 * Saída limpa = seguro rodar `npm run migrate`.
 */
async function main(): Promise<void> {
  const repo = getRepo();
  console.log(`Banco: ${repo.driver} @ ${repo.target}`);

  const orphans = await repo.maintenance.findOrphanInstances();
  if (orphans.length === 0) {
    const total = (await repo.instances.listAll()).length;
    console.log(`OK — ${total} instância(s), todas com org válida. Pode migrar.`);
    await repo.close();
    return;
  }

  console.log(`ATENÇÃO — ${orphans.length} instância(s) órfã(s):`);
  for (const o of orphans) {
    console.log(`  - ${o.id}  "${o.name}"  org_id=${o.org_id ?? '(NULL)'}`);
  }
  console.log('');
  console.log('org_id NULL é corrigido pela própria migration (vira org_default).');
  console.log('org_id apontando para org inexistente precisa de decisão sua:');
  console.log('  UPDATE instances SET org_id = \'<org válida>\' WHERE id = \'<id acima>\';');
  await repo.close();
  process.exitCode = 1; // saída não-zero: dá para encadear em script de deploy
}

main().catch((err) => {
  console.error('FALHA na auditoria:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
