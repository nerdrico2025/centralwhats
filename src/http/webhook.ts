import { Router } from 'express';
import type { Repo } from '../repo';
import {
  processInboundPayload,
  verifyChallenge,
  type VerifyChallengeResult,
} from '../domain/webhook';
import type { MessagingDeps } from '../domain/messaging';
import { requireMetaSignature } from './metaSignature';

/**
 * Agendador do processamento em background. Default: fire-and-forget (não
 * bloqueia a resposta HTTP, conforme CLAUDE.md). Injetável para que testes
 * capturem a promise e aguardem determinísticamente — sem setInterval/timeout.
 */
export type BackgroundScheduler = (task: () => Promise<void>) => void;

const defaultScheduler: BackgroundScheduler = (task) => {
  void task().catch((err) => {
    // Rede de segurança: a task já trata seus próprios erros (ver POST abaixo).
    // eslint-disable-next-line no-console
    console.error('[webhook] erro no processamento em background:', err);
  });
};

/** Mensagem legível de um erro desconhecido (para os logs da Vercel). */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Mascara o token recebido — segredo não vai inteiro para o log. */
function maskToken(v: string | undefined): string {
  if (!v) return '(ausente)';
  return v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)` : `(${v.length} chars)`;
}

/** Traduz o motivo da recusa para uma frase acionável no log. */
function verifyFailureMessage(r: VerifyChallengeResult): string {
  switch (r.reason) {
    case 'mode_invalido':
      return 'hub.mode inválido (esperado "subscribe")';
    case 'token_ausente':
      return 'hub.verify_token ausente na query';
    case 'nenhuma_instancia':
      return 'NENHUMA instância cadastrada no banco — não há verify_token para comparar. Crie a instância (POST /api/instances)';
    case 'nenhuma_instancia_com_verify_token':
      return 'existem instâncias, mas NENHUMA tem verify_token preenchido';
    case 'token_nao_confere':
      if (r.diag?.matchesAfterTrim)
        return 'verify_token bate APÓS trim — há espaço/quebra de linha sobrando no valor salvo ou na query';
      if (r.diag?.matchesIgnoringCase)
        return 'verify_token bate ignorando maiúsc/minúsc — diferença apenas de case';
      return 'verify_token não confere com o de nenhuma instância';
    default:
      return 'motivo desconhecido';
  }
}

/**
 * Rotas do webhook da Meta Cloud API.
 *  GET  /webhook — verificação do desafio (hub.mode/hub.verify_token/hub.challenge).
 *  POST /webhook — responde 200 IMEDIATAMENTE e processa em background.
 *
 * Sem falhas silenciosas (CLAUDE.md): NENHUMA chamada assíncrona daqui pode
 * ficar sem tratamento. Toda rejeição vira (a) log explícito e (b) resposta
 * HTTP — nunca uma promise pendente que segura a request até o
 * FUNCTION_INVOCATION_TIMEOUT da Vercel.
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

    // A lógica de verificação em si não muda: só o tratamento de erro.
    void (async () => {
      let result: VerifyChallengeResult;
      try {
        result = await verifyChallenge(repo, mode, token);
      } catch (err) {
        // Tipicamente falha de conexão com o Postgres ao resolver a instância
        // pelo verify_token. Loga legível e RESPONDE — nunca deixa pendurado.
        // eslint-disable-next-line no-console
        console.error(
          `[webhook] Erro ao conectar no banco durante verificação do webhook: ${errMessage(err)}`,
          err,
        );
        if (!res.headersSent) {
          res.status(500).json({ error: 'Erro ao verificar o webhook (falha de banco)' });
        }
        return;
      }

      if (res.headersSent) return; // client desistiu; nada a responder
      if (result.ok) {
        // A Meta espera o challenge cru em texto puro.
        res.status(200).send(challenge ?? '');
        return;
      }

      // 403 NUNCA silencioso: o log diz o motivo exato, para não investigar às
      // cegas no painel da Vercel. O token recebido sai MASCARADO (é segredo);
      // o comprimento e as dicas de trim/case bastam para achar a diferença.
      // eslint-disable-next-line no-console
      console.warn(
        `[webhook] Verificação recusada (403): ${verifyFailureMessage(result)}`,
        result.diag ?? {},
        `token recebido: ${maskToken(token)}`,
      );
      res.sendStatus(403);
    })();
  });

  // ASSINATURA DA META antes de qualquer processamento: só o POST: o GET de
  // verificação não é assinado assim e segue no verify_token.
  router.post('/', requireMetaSignature(), (req, res) => {
    const payload = req.body;
    // RESPONDE JÁ. Nada de processamento pesado antes do 200 (regra serverless).
    res.sendStatus(200);

    // Processamento pesado em background (idempotente, dedup por wa_message_id).
    // A task trata o próprio erro: a resposta HTTP já saiu, então o único
    // destino possível de uma falha aqui é o log — e ele precisa ser legível,
    // não um "Unhandled Rejection" genérico.
    const task = async (): Promise<void> => {
      try {
        await processInboundPayload(repo, payload, deps);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[webhook] Erro ao processar payload do webhook em background: ${errMessage(err)}`,
          err,
        );
      }
    };

    try {
      schedule(task);
    } catch (err) {
      // Scheduler injetado que lança de forma síncrona: a resposta 200 já foi
      // enviada, então só resta logar (sem derrubar o processo).
      // eslint-disable-next-line no-console
      console.error(
        `[webhook] Erro ao agendar o processamento em background: ${errMessage(err)}`,
        err,
      );
    }
  });

  return router;
}
