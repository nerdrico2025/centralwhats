import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * REGRESSÃO — worker crashava no boot com ERR_UNKNOWN_BUILTIN_MODULE.
 *
 * `node:sqlite` só existe a partir do Node 22.5. O SqliteAdapter resolvia esse
 * builtin no ESCOPO DO MÓDULO, então bastava alguém IMPORTAR o arquivo para o
 * processo morrer em Node 20 — e o factory de repo.* importa os dois adapters.
 * Resultado no Railway (Node 20.20.2), com DB_DRIVER=postgres configurado:
 *
 *   Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
 *       at Object.<anonymous> (/app/dist/repo/adapters/SqliteAdapter.js:49:26)
 *
 * Por que em processo FILHO: a única forma honesta de testar isto é num Node
 * onde `node:sqlite` não existe. Como a máquina de desenvolvimento roda Node
 * 24 (e por isso o bug nunca apareceu localmente), o filho bloqueia o builtin
 * no Module._load — o teste passa a valer em qualquer versão de Node.
 */

const HELPER = path.join(process.cwd(), 'tests', 'helpers', 'bootSemNodeSqlite.cjs');

function bootar(modo: 'postgres' | 'sqlite'): { ok: boolean; driver?: string; target?: string; code?: string | null; message?: string; inesperado?: string } {
  const saida = execFileSync('npx', ['tsx', HELPER, modo], {
    encoding: 'utf8',
    cwd: process.cwd(),
    timeout: 60_000,
  });
  const linha = saida.trim().split('\n').filter(Boolean).pop() as string;
  return JSON.parse(linha);
}

describe('boot sem node:sqlite (Node < 22.5)', () => {
  it('getRepo() com DB_DRIVER=postgres NÃO toca em node:sqlite', () => {
    const r = bootar('postgres');
    expect(r.ok, `boot falhou: ${r.code ?? ''} ${r.message ?? ''}`).toBe(true);
    expect(r.driver).toBe('postgres');
    // Alvo sem credencial — a regra de nunca logar segredo continua valendo.
    expect(r.target).toBe('db.exemplo.invalido:5432/postgres');
  }, 90_000);

  it('quem pede SQLite de verdade falha com mensagem ACIONÁVEL, não com builtin cru', () => {
    const r = bootar('sqlite');
    expect(r.ok, 'criar adapter sqlite sem o builtin deveria falhar').toBe(false);
    // A mensagem tem de dizer o que fazer; ERR_UNKNOWN_BUILTIN_MODULE sozinho
    // manda o operador investigar o lugar errado (foi o que aconteceu).
    expect(r.message).toMatch(/node:sqlite/);
    expect(r.message).toMatch(/22\.5/);
    expect(r.message).toMatch(/DB_DRIVER=postgres/);
  }, 90_000);
});
