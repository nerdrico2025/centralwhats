import { Router, type Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Repo } from '../repo';
import { processAllPendingCampaigns } from '../domain/dispatch';
import { processAllPendingFlows } from '../domain/flows';
import type { MessagingDeps } from '../domain/messaging';
import { loadEnv } from '../config';
import { asyncHandler, HttpError } from './util';

/**
 * Fatia dos fluxos dentro da invocação. O orçamento de campanhas (20s) já é
 * dimensionado para o maxDuration de 30s; os fluxos rodam antes e precisam de
 * teto próprio para não comerem a invocação inteira numa instância movimentada.
 */
const FLOWS_BUDGET_MS = 8000;

/** Compara sem vazar o tamanho do prefixo correto por tempo de resposta. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extrai o token de "Authorization: Bearer <token>" (formato que a Vercel envia). */
function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token || null;
}

/**
 * Rotas de CRON — chamadas pelo agendador da Vercel (vercel.json §crons),
 * NUNCA por um usuário logado. Por isso este router é montado ANTES do
 * middleware de autenticação: ele tem o próprio mecanismo (CRON_SECRET).
 *
 * Esta rota dispara ENVIO REAL de mensagem. Ela nunca pode ficar aberta:
 * sem o segredo correto, 401 e nada é processado.
 */
export function createCronRouter(repo: Repo, deps: MessagingDeps = {}): Router {
  const router = Router();

  // GET **e** POST no mesmo handler: o agendador da Vercel dispara o path com
  // GET, então só POST nunca seria chamado em produção. O GET aqui muda estado
  // (dispara envio), o que normalmente seria proibido — é concessão à
  // plataforma, contida por não existir caminho anônimo até ele.
  router.all(
    '/tick-campaigns',
    asyncHandler(async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        throw new HttpError(405, 'Método não permitido');
      }
      const expected = loadEnv().CRON_SECRET;
      // Sem segredo configurado a rota fica FECHADA. O contrário — liberar
      // quando a variável falta — transformaria um deploy incompleto num
      // endpoint público de disparo em massa.
      if (!expected) {
        throw new HttpError(
          503,
          'CRON_SECRET não configurado — varredura desabilitada. Defina a variável de ambiente na Vercel.',
        );
      }

      const provided = bearerToken(req);
      if (!provided || !secretMatches(provided, expected)) {
        // Log sem o valor recebido (não se registra segredo de tentativa).
        // eslint-disable-next-line no-console
        console.warn('[cron] chamada recusada: segredo ausente ou inválido');
        throw new HttpError(401, 'Não autorizado');
      }

      // Fluxos primeiro (varredura curta e barata), campanhas depois com o
      // resto do orçamento: um "Aguardar" vencido é resposta a um lead que já
      // está conversando, enquanto a campanha tolera esperar o próximo tick.
      const flows = await processAllPendingFlows(repo, deps, { budgetMs: FLOWS_BUDGET_MS });
      const campaigns = await processAllPendingCampaigns(repo, deps);

      const result = { flows, campaigns };
      // eslint-disable-next-line no-console
      console.log('[cron] varredura:', JSON.stringify(result));
      res.json(result);
    }),
  );

  return router;
}
