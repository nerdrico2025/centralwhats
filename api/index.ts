import { waitUntil } from '@vercel/functions';
import { createApp } from '../src/http/app';
import { getRepo } from '../src/repo';

/**
 * Entrypoint SERVERLESS (Vercel). Todas as rotas (API, webhook e estáticos)
 * são reescritas para esta function (ver vercel.json).
 *
 * Ponto crítico: em serverless, um fire-and-forget após o `res` pode ser
 * cortado quando a request termina. Por isso o processamento em background do
 * webhook usa waitUntil() — a plataforma mantém a function viva até a promise
 * resolver, SEM atrasar a resposta HTTP (a regra "webhook responde já" segue
 * valendo).
 *
 * O repo é memoizado por processo (getRepo) — lambdas quentes reaproveitam a
 * conexão. Migrations NÃO rodam por request: rode `npm run migrate` apontando
 * pro Postgres antes do deploy (ver DEPLOY.md).
 */
const app = createApp(getRepo(), {
  scheduleWebhook: (task) => {
    waitUntil(
      task().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[webhook] erro no processamento em background:', err);
      }),
    );
  },
});

export default app;
