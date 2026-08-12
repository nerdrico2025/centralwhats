import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type Request, type Response, type Router } from 'express';
import { getRepo, type Repo } from '../repo';
import { findProjectRoot } from '../util/paths';
import type { Instance } from '../repo/types';
import type { Provider } from '../providers/types';
import { createInstancesRouter } from './instances';
import { createMessagesRouter } from './messages';
import { createTemplatesRouter } from './templates';
import { createContactsRouter } from './contacts';
import { createTagsRouter } from './tags';
import { createCrmRouter } from './crm';
import { createLiveChatRouter } from './livechat';
import { createDashboardRouter } from './dashboard';
import { createListsRouter } from './lists';
import { createCampaignsRouter } from './campaigns';
import { createCronRouter } from './cron';
import { captureRawBody } from './metaSignature';
import { createFlowsRouter } from './flows';
import { createWebhookRouter, type BackgroundScheduler } from './webhook';
import { createAuthMiddleware, createAuthRouter } from './auth';
import { createInvitesRouter, createSessionRouter, createUsersRouter } from './team';
import { errorMiddleware, requireOwner } from './util';
import type { MetaTemplatesOptions } from '../providers/metaTemplates';

/**
 * TABELA das rotas escopadas por instância (P6.1).
 *
 * Existe para que "montar um router novo" e "declarar que ele é escopado por
 * conta" sejam o MESMO ato. O teste tests/orgscope.test.ts percorre esta lista
 * e exige, de cada mount, 404 cross-org — então um router novo entra no teste
 * automaticamente, em vez de depender de alguém lembrar de adicioná-lo.
 *
 * `ownerOnly`: agent (Live Chat) só passa em messages/conversations.
 */
export interface InstanceScopedMount {
  segment: string;
  ownerOnly: boolean;
  make: (repo: Repo, deps: AppDeps) => Router;
}

export const INSTANCE_SCOPED_MOUNTS: InstanceScopedMount[] = [
  // Atendimento — agent também usa.
  {
    segment: 'messages',
    ownerOnly: false,
    make: (repo, deps) => createMessagesRouter(repo, { providerFor: deps.providerFor }),
  },
  { segment: 'conversations', ownerOnly: false, make: (repo) => createLiveChatRouter(repo) },
  // Gestão — owner only.
  {
    segment: 'templates',
    ownerOnly: true,
    make: (repo, deps) => createTemplatesRouter(repo, deps.templatesApi ?? {}),
  },
  { segment: 'contacts', ownerOnly: true, make: (repo) => createContactsRouter(repo) },
  { segment: 'tags', ownerOnly: true, make: (repo) => createTagsRouter(repo) },
  { segment: 'crm', ownerOnly: true, make: (repo) => createCrmRouter(repo) },
  { segment: 'dashboard', ownerOnly: true, make: (repo) => createDashboardRouter(repo) },
  { segment: 'lists', ownerOnly: true, make: (repo) => createListsRouter(repo) },
  { segment: 'flows', ownerOnly: true, make: (repo) => createFlowsRouter(repo) },
  {
    segment: 'campaigns',
    ownerOnly: true,
    make: (repo, deps) => createCampaignsRouter(repo, { providerFor: deps.providerFor }),
  },
];

export interface AppDeps {
  /** Agendador do processamento em background do webhook (injetável em testes). */
  scheduleWebhook?: BackgroundScheduler;
  /** Resolve o provider da instância (injetável em testes para mockar envio). */
  providerFor?: (instance: Instance) => Provider;
  /** Opções do client de templates (fetch injetável em testes). */
  templatesApi?: MetaTemplatesOptions;
}

/**
 * Monta o app Express. Recebe o `repo` por injeção (default: getRepo()) para
 * que os testes usem um adapter SQLite in-memory sem tocar em arquivo/env.
 *
 * Regra de webhook (CLAUDE.md): responder HTTP imediatamente; processamento
 * pesado roda em background. Implementado em ./webhook.
 */
export function createApp(repo: Repo = getRepo(), deps: AppDeps = {}): Express {
  const app = express();
  // `verify` guarda os bytes ORIGINAIS do corpo: é o que o HMAC do webhook da
  // Meta assina. Recalcular sobre o objeto já parseado não reproduz os mesmos
  // bytes (ordem de chaves, escapes) e a assinatura falharia sempre.
  app.use(express.json({ limit: '2mb', verify: captureRawBody }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'wa-manager', phase: 'P2.1' });
  });

  // === Auth pública (V2/P5.1) — ANTES do middleware de autenticação ===
  app.use('/api/auth', createAuthRouter(repo));

  // === Cron da Vercel — ANTES do middleware de autenticação ===
  // Não é chamado por usuário logado: autentica pelo CRON_SECRET (ver cron.ts).
  app.use('/api/cron', createCronRouter(repo, { providerFor: deps.providerFor }));

  // === API REST (autenticada; modo bootstrap mantém a V1 sem login) ===
  const api = express.Router();
  api.use(createAuthMiddleware(repo));

  // Sessão: quem sou eu, em que conta estou, trocar de conta/senha.
  // Disponível para QUALQUER papel — é o que permite ao agente trocar a
  // própria senha e alternar entre as contas de que participa.
  api.use('/me', createSessionRouter(repo));

  // Rotas escopadas por instância — montadas a partir da tabela acima.
  for (const mount of INSTANCE_SCOPED_MOUNTS) {
    const path = `/instances/:id/${mount.segment}`;
    if (mount.ownerOnly) api.use(path, requireOwner, mount.make(repo, deps));
    else api.use(path, mount.make(repo, deps));
  }

  // Owner only: equipe e convites da conta ativa.
  api.use('/users', requireOwner, createUsersRouter(repo));
  api.use('/invites', requireOwner, createInvitesRouter(repo));
  api.use('/instances', createInstancesRouter(repo)); // papel checado por rota
  app.use('/api', api);

  // === Webhook da Meta Cloud API ===
  app.use('/webhook', createWebhookRouter(repo, deps.scheduleWebhook, { providerFor: deps.providerFor }));

  // === Frontend estático (SPA) — servido de /public quando existir (build:web) ===
  // ATENÇÃO: na Vercel este bloco NÃO roda — `public/` é servido pela CDN e não
  // entra no bundle da function, então fs.existsSync() é false lá. O fallback de
  // SPA em produção é o rewrite `/(.*) → /index.html` do vercel.json; sem ele,
  // refresh em /livechat cai aqui e vira 404 do Express. Isto aqui serve o
  // `npm start` local, onde public/ existe de verdade.
  const webDir = path.join(findProjectRoot(), 'public');
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir));
    // Fallback do SPA: GET que não é /api, /webhook ou /health → index.html.
    app.get(/^\/(?!api\/|webhook|health).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  // Middleware final de erro (sempre por último).
  app.use(errorMiddleware);

  return app;
}
