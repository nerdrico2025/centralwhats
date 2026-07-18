import fs from 'node:fs';
import path from 'node:path';

/**
 * Sobe a árvore a partir de __dirname até achar o package.json — estável em
 * dev (tsx/src), teste (vitest/src) e build (dist), sem depender de cwd.
 */
export function findProjectRoot(startDir: string = __dirname): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('findProjectRoot: package.json não encontrado subindo a árvore');
}

/** Lista os arquivos .sql de migração de um driver, em ordem lexicográfica. */
export function listMigrations(driver: 'sqlite' | 'postgres'): {
  name: string;
  sql: string;
}[] {
  const dir = path.join(findProjectRoot(), 'migrations', driver);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(dir, name), 'utf8'),
    }));
}
