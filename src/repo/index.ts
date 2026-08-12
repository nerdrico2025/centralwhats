import { loadEnv } from '../config';
import type { Repo } from './Repo';
import { createSqliteAdapter } from './adapters/SqliteAdapter';
import { createPostgresAdapter } from './adapters/PostgresAdapter';

/**
 * REGRA DOS ADAPTERS (aprendida com um crash em produção):
 *
 * Este factory importa os DOIS adapters de forma estática — logo, um processo
 * que só usa Postgres também carrega o módulo do SQLite, e vice-versa. Isso é
 * aceitável APENAS enquanto valer a regra abaixo:
 *
 *   NENHUM adapter pode resolver dependência específica de ambiente (builtin
 *   novo, binário nativo, arquivo em disco) no ESCOPO DO MÓDULO. Só dentro da
 *   função de criação, que roda apenas para o driver escolhido.
 *
 * Quando essa regra foi quebrada, o worker Baileys no Railway (Node 20.20.2)
 * morria no boot com ERR_UNKNOWN_BUILTIN_MODULE por causa do `node:sqlite`
 * exigido no topo do SqliteAdapter — mesmo estando configurado com
 * DB_DRIVER=postgres. Ver tests/nodesqlite.test.ts, que trava esse contrato.
 *
 * (Import tardio por driver seria a alternativa, mas exigiria `require`
 * síncrono de módulo TS — que não funciona sob o vitest, onde os módulos são
 * servidos por ESM. Foi medido, não suposto.)
 */

export type { Repo } from './Repo';
export * from './types';

let cached: Repo | null = null;

/**
 * Factory da camada de dados. Escolhe o adapter por DB_DRIVER (sqlite|postgres).
 * Memoizado: uma instância de Repo por processo.
 */
export function getRepo(): Repo {
  if (cached) return cached;
  const env = loadEnv();

  // SEM fallback default: driver desconhecido é ERRO, nunca SQLite calado.
  // (O zod já valida o enum; isto é defesa em profundidade.)
  switch (env.DB_DRIVER) {
    case 'postgres': {
      if (!env.DATABASE_URL) {
        throw new Error('DB_DRIVER=postgres exige DATABASE_URL definida');
      }
      cached = createPostgresAdapter({ connectionString: env.DATABASE_URL });
      break;
    }
    case 'sqlite':
      cached = createSqliteAdapter({ path: env.SQLITE_PATH });
      break;
    default: {
      const exhaustive: never = env.DB_DRIVER;
      throw new Error(`DB_DRIVER desconhecido: "${String(exhaustive)}"`);
    }
  }
  return cached;
}

/** Reseta o cache — útil em testes. */
export function resetRepoCache(): void {
  cached = null;
}
