/**
 * Processo filho que SIMULA um Node sem `node:sqlite` (o caso do Node 20 do
 * Railway) e faz o boot de `repo.*` com DB_DRIVER=postgres.
 *
 * Rodado por tests/nodesqlite.test.ts via tsx. Não é um teste em si — é o
 * ambiente controlado onde o teste observa o comportamento.
 *
 * Roda em qualquer versão de Node: o bloqueio é feito no `Module._load`, então
 * o resultado não depende da versão da máquina de quem roda a suíte (a minha
 * tem node:sqlite; a do Railway não tinha — e era exatamente esse o problema).
 */
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, ...resto) {
  if (request === 'node:sqlite' || request === 'sqlite') {
    const err = new Error('No such built-in module: node:sqlite');
    err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
    throw err;
  }
  return originalLoad.call(this, request, ...resto);
};

process.env.DB_DRIVER = 'postgres';
process.env.DATABASE_URL = 'postgres://u:p@db.exemplo.invalido:5432/postgres';
process.env.NODE_ENV = 'test';

const modo = process.argv[2]; // 'postgres' | 'sqlite'

try {
  // require via tsx: resolve o TypeScript do src.
  const { getRepo, resetRepoCache } = require('../../src/repo');
  resetRepoCache();

  if (modo === 'sqlite') {
    // Caminho que REALMENTE precisa do builtin: tem de falhar, com mensagem
    // acionável (e não com um ERR_UNKNOWN_BUILTIN_MODULE cru).
    const { createSqliteAdapter } = require('../../src/repo/adapters/SqliteAdapter');
    createSqliteAdapter({ path: ':memory:' });
    console.log(JSON.stringify({ ok: true, inesperado: 'sqlite funcionou sem node:sqlite' }));
    return;
  }

  const repo = getRepo();
  console.log(JSON.stringify({ ok: true, driver: repo.driver, target: repo.target }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, code: err.code ?? null, message: String(err.message) }));
}
