import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnv, resetEnvCache } from '../src/config';
import { getRepo, resetRepoCache } from '../src/repo';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createPostgresAdapter } from '../src/repo/adapters/PostgresAdapter';

/**
 * Regressão do bug de configuração: migrate "funcionando" no banco errado.
 * A regra: o driver é SEMPRE determinado por DB_DRIVER, e contradição de
 * config é ERRO ALTO — nunca fallback silencioso pro SQLite.
 */

const ENV_KEYS = ['DB_DRIVER', 'DATABASE_URL', 'SQLITE_PATH', 'NODE_ENV'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetEnvCache();
  resetRepoCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
  resetRepoCache();
});

describe('validação de env (anti-fallback silencioso)', () => {
  it('DATABASE_URL presente SEM DB_DRIVER=postgres → erro claro (não cai pro sqlite)', () => {
    process.env.DATABASE_URL = 'postgres://x:y@db.supabase.co:5432/postgres';
    // DB_DRIVER ausente (default seria sqlite) — é o cenário do bug relatado.
    expect(() => loadEnv()).toThrow(/DATABASE_URL está definida mas DB_DRIVER/);

    // Idem com DB_DRIVER=sqlite explícito.
    resetEnvCache();
    process.env.DB_DRIVER = 'sqlite';
    expect(() => loadEnv()).toThrow(/não vou cair pro SQLite em silêncio/);
  });

  it('DB_DRIVER=postgres SEM DATABASE_URL → erro claro', () => {
    process.env.DB_DRIVER = 'postgres';
    expect(() => loadEnv()).toThrow(/DATABASE_URL é obrigatória/);
  });

  it('DB_DRIVER com typo/valor inválido → erro (nunca aceita calado)', () => {
    process.env.DB_DRIVER = 'postgress';
    expect(() => loadEnv()).toThrow(/Configuração de ambiente inválida/);
  });

  it('config coerente passa: postgres+URL e sqlite puro', () => {
    process.env.DB_DRIVER = 'postgres';
    process.env.DATABASE_URL = 'postgres://x:y@host:5432/db';
    expect(loadEnv().DB_DRIVER).toBe('postgres');

    resetEnvCache();
    delete process.env.DATABASE_URL;
    process.env.DB_DRIVER = 'sqlite';
    expect(loadEnv().DB_DRIVER).toBe('sqlite');
  });
});

describe('getRepo respeita DB_DRIVER (identidade do adapter)', () => {
  it('postgres → adapter postgres com alvo SEM credenciais', () => {
    process.env.DB_DRIVER = 'postgres';
    process.env.DATABASE_URL = 'postgres://user:senha-secreta@db.abc.supabase.co:5432/postgres';
    const repo = getRepo();
    expect(repo.driver).toBe('postgres');
    expect(repo.target).toBe('db.abc.supabase.co:5432/postgres');
    expect(repo.target).not.toContain('senha-secreta'); // credencial nunca em log
  });

  it('sqlite (default sem DATABASE_URL) → adapter sqlite com caminho absoluto', () => {
    const repo = getRepo();
    expect(repo.driver).toBe('sqlite');
    expect(repo.target.endsWith('wa-manager.sqlite')).toBe(true);
    expect(repo.target.startsWith('/')).toBe(true); // absoluto, sem ambiguidade
  });
});

describe('identidade direta dos adapters', () => {
  it('cada adapter declara driver/target corretos', () => {
    const sq = createSqliteAdapter({ path: ':memory:' });
    expect(sq.driver).toBe('sqlite');
    expect(sq.target).toBe(':memory:');

    const pgRepo = createPostgresAdapter({
      connectionString: 'postgres://u:p@meu-host:6543/db?pgbouncer=true',
    });
    expect(pgRepo.driver).toBe('postgres');
    expect(pgRepo.target).toBe('meu-host:6543/db');
  });
});
