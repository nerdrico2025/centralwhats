import { loadEnv } from '../config';
import { getRepo } from '../repo';
import { BaileysWorker } from './baileysWorker';
import { makeRealSocketFactory } from './realSocket';

/**
 * Entrypoint do WORKER BAILEYS (V2 / P5.2).
 *
 * Deploy: processo Node SEMPRE-LIGADO (Railway / Fly.io / VPS pequeno)
 * apontando pro MESMO Postgres da camada web (DATABASE_URL igual):
 *   DB_DRIVER=postgres DATABASE_URL=... npm run worker
 * Não fala HTTP com o resto do sistema — compartilha o banco (outbox).
 */
async function main(): Promise<void> {
  loadEnv();
  const repo = getRepo();
  // eslint-disable-next-line no-console
  console.log(`[worker] banco: ${repo.driver} @ ${repo.target}`);
  await repo.migrate();

  const worker = new BaileysWorker(repo, {
    socketFactory: makeRealSocketFactory(repo),
  });
  await worker.start();
  // eslint-disable-next-line no-console
  console.log('[worker] Baileys worker rodando (sockets + outbox).');

  const shutdown = async (): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log('[worker] encerrando…');
    await worker.stop();
    await repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
