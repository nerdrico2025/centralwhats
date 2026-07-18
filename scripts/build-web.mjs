#!/usr/bin/env node
/*
 * Build do frontend com CACHE-BUSTING (CLAUDE.md §Frontend).
 *
 * Gera em /public os assets com HASH DE CONTEÚDO no nome
 * (app.<hash>.js, styles.<hash>.css) e reescreve o index.html apontando para
 * eles. Como o hash deriva do conteúdo, qualquer mudança no JS/CSS muda a URL
 * do arquivo — o browser nunca serve código velho por cache.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src', 'web');
const outDir = path.join(root, 'public');

function hash(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// CSS
const css = fs.readFileSync(path.join(srcDir, 'styles.css'));
const cssName = `styles.${hash(css)}.css`;
fs.writeFileSync(path.join(outDir, cssName), css);

// JS
const js = fs.readFileSync(path.join(srcDir, 'app.js'));
const jsName = `app.${hash(js)}.js`;
fs.writeFileSync(path.join(outDir, jsName), js);

// index.html com os nomes versionados
let html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8');
html = html.replaceAll('__CSS__', cssName).replaceAll('__JS__', jsName);
fs.writeFileSync(path.join(outDir, 'index.html'), html);

console.log(`[build-web] gerado public/ com ${cssName} e ${jsName}`);
