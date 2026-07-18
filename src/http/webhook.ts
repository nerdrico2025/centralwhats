import { Router } from 'express';
import type { Repo } from '../repo';
import { isValidVerifyChallenge, processInboundPayload } from '../domain/webhook';
import type { MessagingDeps } from '../domain/messaging';

/**
 * Agendador do processamento em background. Default: fire-and-forget (não
 * bloqueia a resposta HTTP, conforme CLAUDE.md). Injetável para que testes
 * capturem a promise e aguardem determinísticamente — sem setInterval/timeout.
 */
export type BackgroundScheduler = (task: () => Promise<void>) => void;

const defaultScheduler: BackgroundScheduler = (task) => {
  void task().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[webhook] erro no processamento em background:', err);
  });
};

/**
 * Rotas do webhook da Meta Cloud API.
 *  GET  /webhook — verificação do desafio (hub.mode/hub.verify_token/hub.challenge).
 *  POST /webhook — responde 200 IMEDIATAMENTE e processa em background.
 */
export function createWebhookRouter(
  repo: Repo,
  schedule: BackgroundScheduler = defaultScheduler,
  deps: MessagingDeps = {},
): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'] as string | undefined;
    const token = req.query['hub.verify_token'] as string | undefined;
    const challenge = req.query['hub.challenge'] as string | undefined;

    void isValidVerifyChallenge(repo, mode, token).then((ok) => {
      if (ok) {
        // A Meta espera o challenge cru em texto puro.
        res.status(200).send(challenge ?? '');
      } else {
        res.sendStatus(403);
      }
    });
  });

  router.post('/', (req, res) => {
    const payload = req.body;
    // RESPONDE JÁ. Nada de processamento pesado antes do 200 (regra serverless).
    res.sendStatus(200);
    // Processamento pesado em background (idempotente, dedup por wa_message_id).
    schedule(() => processInboundPayload(repo, payload, deps).then(() => undefined));
  });

  return router;
}
