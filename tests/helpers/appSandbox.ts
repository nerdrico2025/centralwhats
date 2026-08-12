import fs from 'node:fs';
import path from 'node:path';

/**
 * Harness de DOM mínimo para exercitar o `src/web/app.js` REAL em teste.
 *
 * Por que existe: o app.js é script de browser (sem exports) e os bugs mais
 * caros desta fase foram de COMPORTAMENTO de tela — polling redesenhando por
 * cima do que o usuário digita. Asserção sobre o código-fonte não pegaria isso;
 * rodar o arquivo de verdade, sim.
 *
 * Usado por tests/loginloop.test.ts e tests/livechatcomposer.test.ts.
 */

export class FakeEl {
  children: FakeEl[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  className = '';
  id = '';
  value = '';
  textContent = '';
  style: Record<string, string> = {};
  // Geometria de rolagem (o Live Chat decide se rola pro fim a partir dela).
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  constructor(readonly tag: string) {}

  set innerHTML(v: string) {
    if (v === '') this.children = [];
  }
  get innerHTML(): string {
    return '';
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  addEventListener(ev: string, fn: (e: unknown) => void): void {
    (this.listeners[ev] ||= []).push(fn);
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  select(): void {}
  focus(): void {}
  replaceWith(): void {}

  /** Dispara um evento registrado via addEventListener (ex.: 'click'). */
  fire(ev: string, arg: unknown = {}): void {
    for (const fn of this.listeners[ev] ?? []) fn(arg);
  }

  /** Primeiro nó da árvore que casa com o predicado. */
  query(pred: (el: FakeEl) => boolean): FakeEl | null {
    if (pred(this)) return this;
    for (const c of this.children) {
      const hit = c.query(pred);
      if (hit) return hit;
    }
    return null;
  }

  /** Todos os nós da árvore que casam com o predicado. */
  queryAll(pred: (el: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    if (pred(this)) out.push(this);
    for (const c of this.children) out.push(...c.queryAll(pred));
    return out;
  }

  /** Atalho: acha um campo pelo placeholder. */
  find(placeholder: string): FakeEl | null {
    return this.query((el) => el.attrs.placeholder === placeholder);
  }

  /** Atalho: acha o primeiro nó com a classe informada. */
  byClass(cls: string): FakeEl | null {
    return this.query((el) => el.className.split(' ').includes(cls));
  }
}

export interface FakeResponse {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}

export type FetchImpl = (url: string, init?: { method?: string }) => Promise<FakeResponse>;

export interface SandboxOpts {
  fetchImpl: FetchImpl;
  /** Símbolos top-level do app.js a devolver (ex.: 'api', 'livechatScreen'). */
  expose: string[];
}

export interface Sandbox {
  appEl: FakeEl;
  fetchCalls: { url: string; method: string }[];
  // Símbolos expostos do app.js — tipagem frouxa de propósito (é script de browser).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [nome: string]: any;
}

/** JSON 200 pronto, para os stubs de fetch dos testes. */
export function json200(body: unknown): FakeResponse {
  return { status: 200, ok: true, json: () => Promise.resolve(body) };
}

/**
 * Carrega o app.js real num sandbox com DOM/fetch falsos. O `boot()` final é
 * removido — ele dispara requests de verdade e monta o painel inteiro.
 */
export function loadApp(opts: SandboxOpts): Sandbox {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'app.js'), 'utf8');
  const semBoot = source.replace(/\nboot\(\);\s*$/, '\n');
  if (semBoot === source) {
    throw new Error('boot() não encontrado no fim do app.js — o harness precisa ser revisto');
  }

  const appEl = new FakeEl('div');
  appEl.id = 'app';
  const fetchCalls: { url: string; method: string }[] = [];

  const store: Record<string, string> = {};
  const localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };

  const doc = {
    getElementById: (id: string) => (id === 'app' ? appEl : new FakeEl('div')),
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => {
      const el = new FakeEl('#text');
      el.textContent = t;
      return el;
    },
  };

  const wrappedFetch: FetchImpl = (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' });
    return opts.fetchImpl(url, init);
  };

  const fn = new Function(
    'document',
    'localStorage',
    'fetch',
    'location',
    'history',
    'window',
    'navigator',
    'alert',
    'console',
    `${semBoot}\n; return { ${opts.expose.join(', ')} };`,
  );

  const exposed = fn(
    doc,
    localStorage,
    wrappedFetch,
    { pathname: '/', origin: 'http://localhost', reload: () => {}, href: '' },
    { pushState: () => {} },
    { addEventListener: () => {} },
    { clipboard: null },
    () => {},
    { error: () => {}, log: () => {}, warn: () => {} },
  ) as Record<string, unknown>;

  return { ...exposed, appEl, fetchCalls };
}

/** Esvazia a fila de microtasks (cadeias de .then dos fetches). */
export async function flush(vezes = 30): Promise<void> {
  for (let i = 0; i < vezes; i++) await Promise.resolve();
}
