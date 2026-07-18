import { getRepo } from './index';

/* eslint-disable no-console */

/**
 * Entrypoint do `npm run migrate`. Delega ao adapter escolhido por DB_DRIVER.
 *
 * O driver e o ALVO são impressos ANTES de rodar — se você esperava Postgres
 * e vir "sqlite" aqui, a env não chegou ao processo (typo em DB_DRIVER,
 * export em outro shell etc.). Config contraditória (DATABASE_URL sem
 * DB_DRIVER=postgres) nem chega aqui: loadEnv() lança na validação.
 */
async function main(): Promise<void> {
  const repo = getRepo();
  console.log(`Rodando migrations em: ${repo.driver} @ ${repo.target}`);
  if (repo.driver === 'sqlite' && process.env.DATABASE_URL) {
    // Cinto e suspensório — a validação de env já deve ter barrado isso.
    throw new Error(
      'DATABASE_URL definida mas o driver ativo é sqlite — abortando para não migrar o banco errado.',
    );
  }
  await repo.migrate();
  await repo.close();
  console.log(`Migrations concluídas em: ${repo.driver} @ ${repo.target}`);
}

main().catch((err) => {
  console.error('FALHA nas migrations:');
  console.error(err);
  process.exit(1);
});
