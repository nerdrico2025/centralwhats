import { loadEnv } from '../config';
import type { Repo } from './Repo';
import { createSqliteAdapter } from './adapters/SqliteAdapter';
import { createPostgresAdapter } from './adapters/PostgresAdapter';

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
