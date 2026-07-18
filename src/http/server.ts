import { loadEnv } from '../config';
import { getRepo } from '../repo';
import { createApp } from './app';

/**
 * Entrypoint HTTP para dev/local. Em serverless, a plataforma importa o app
 * de app.ts diretamente — este listen() é só para rodar localmente.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const repo = getRepo();
  // eslint-disable-next-line no-console
  console.log(`Banco: ${repo.driver} @ ${repo.target}`);
  await repo.migrate();
  const app = createApp(repo);
  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`WA Manager ouvindo em http://localhost:${env.PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
