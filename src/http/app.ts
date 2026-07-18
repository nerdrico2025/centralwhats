import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
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
import { createFlowsRouter } from './flows';
import { createWebhookRouter, type BackgroundScheduler } from './webhook';
import { createAuthMiddleware, createAuthRouter, createUsersRouter } from './auth';
import { errorMiddleware, requireOwner } from './util';
import type { MetaTemplatesOptions } from '../providers/metaTemplates';

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
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'wa-manager', phase: 'P2.1' });
  });

  // === Auth pública (V2/P5.1) — ANTES do middleware de autenticação ===
  app.use('/api/auth', createAuthRouter(repo));

  // === API REST (autenticada; modo bootstrap mantém a V1 sem login) ===
  const api = express.Router();
  api.use(createAuthMiddleware(repo));

  // Agent (Live Chat) pode: listar instâncias, conversar e responder.
  api.use('/instances/:id/messages', createMessagesRouter(repo, { providerFor: deps.providerFor }));
  api.use('/instances/:id/conversations', createLiveChatRouter(repo));

  // Owner only: gestão de instâncias/marketing/fluxos/usuários.
  api.use('/instances/:id/templates', requireOwner, createTemplatesRouter(repo, deps.templatesApi ?? {}));
  api.use('/instances/:id/contacts', requireOwner, createContactsRouter(repo));
  api.use('/instances/:id/tags', requireOwner, createTagsRouter(repo));
  api.use('/instances/:id/crm', requireOwner, createCrmRouter(repo));
  api.use('/instances/:id/dashboard', requireOwner, createDashboardRouter(repo));
  api.use('/instances/:id/lists', requireOwner, createListsRouter(repo));
  api.use('/instances/:id/flows', requireOwner, createFlowsRouter(repo));
  api.use('/instances/:id/campaigns', requireOwner, createCampaignsRouter(repo, { providerFor: deps.providerFor }));
  api.use('/users', requireOwner, createUsersRouter(repo));
  api.use('/instances', createInstancesRouter(repo)); // papel checado por rota
  app.use('/api', api);

  // === Webhook da Meta Cloud API ===
  app.use('/webhook', createWebhookRouter(repo, deps.scheduleWebhook, { providerFor: deps.providerFor }));

  // === Frontend estático (SPA) — servido de /public quando existir (build:web) ===
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
