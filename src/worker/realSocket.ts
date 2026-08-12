import { createRequire } from 'node:module';
import type { Repo } from '../repo';
import { makeDbAuthState } from './dbAuthState';
import type { BaileysSocketLike, SocketFactory } from './baileysWorker';

const nodeRequire = createRequire(__filename);

/** Versão do protocolo do WhatsApp Web: `[major, minor, build]`. */
export type WaVersion = [number, number, number];

export interface WaVersionInfo {
  /** `null` = não resolvemos nada; o default embutido na lib vale. */
  version: WaVersion | null;
  source: 'fetch' | 'fallback';
  /** Motivo do fallback (só quando `source === 'fallback'`). */
  error?: string;
}

/**
 * Resolve a versão do protocolo do WhatsApp Web.
 *
 * POR QUÊ (bug real de produção): o Baileys embute uma versão FIXA e o
 * WhatsApp derruba o handshake com `<failure reason="405">` quando ela
 * envelhece — ANTES de emitir qualquer QR. Sintoma no log: "connected to WA /
 * not logged in, attempting registration... / connection errored" em loop, com
 * o botão QR do painel eternamente vazio (nenhum evento `qr` chega).
 *
 * O fetch NÃO pode ser obrigatório: se a fonte da versão estiver fora do ar, o
 * worker cai no default da lib e segue de pé. Indisponibilidade externa não
 * derruba instâncias JÁ pareadas, que nem dependem disso para reconectar.
 */
export async function resolveWaVersion(deps: {
  fetchLatest: () => Promise<{ version: WaVersion }>;
  /** Default embutido na lib; pode devolver `null` se nem isso for legível. */
  fallback: () => WaVersion | null;
}): Promise<WaVersionInfo> {
  const fallback = (error: string): WaVersionInfo => {
    let version: WaVersion | null = null;
    try {
      version = deps.fallback();
    } catch {
      version = null; // sem default legível: o makeWASocket usa o dele
    }
    return { version, source: 'fallback', error };
  };

  try {
    const res = await deps.fetchLatest();
    const version = res?.version;
    if (!Array.isArray(version) || version.length < 3 || version.some((n) => !Number.isFinite(n))) {
      return fallback(`resposta inesperada de fetchLatestBaileysVersion: ${JSON.stringify(res)}`);
    }
    return { version: [version[0], version[1], version[2]], source: 'fetch' };
  } catch (err) {
    return fallback((err as Error)?.message ?? String(err));
  }
}

interface BaileysLib {
  default?: (opts: unknown) => BaileysSocketLike;
  makeWASocket?: (opts: unknown) => BaileysSocketLike;
  fetchLatestBaileysVersion: () => Promise<{ version: WaVersion }>;
  DEFAULT_CONNECTION_CONFIG?: { version?: WaVersion };
}

const loadBaileys = (): BaileysLib => nodeRequire('@whiskeysockets/baileys') as BaileysLib;

/** Cache de processo: UMA resolução por boot, compartilhada por todas as instâncias. */
let versionOnce: Promise<WaVersionInfo> | null = null;

/**
 * Versão resolvida uma única vez por processo (não por reconexão/instância).
 * Loga o resultado no boot — se o WhatsApp voltar a rejeitar o handshake, o
 * primeiro log do worker já diz qual versão está indo e de onde ela veio.
 */
export function getWaVersion(): Promise<WaVersionInfo> {
  if (!versionOnce) {
    versionOnce = resolveWaVersion({
      fetchLatest: () => loadBaileys().fetchLatestBaileysVersion(),
      fallback: () => loadBaileys().DEFAULT_CONNECTION_CONFIG?.version ?? null,
    }).then((info) => {
      const alvo = info.version ? info.version.join('.') : 'default da lib';
      // eslint-disable-next-line no-console
      console.log(
        info.source === 'fetch'
          ? `[worker] versão do WhatsApp Web: ${alvo} (buscada)`
          : `[worker] versão do WhatsApp Web: ${alvo} (FALLBACK — ${info.error})`,
      );
      return info;
    });
  }
  return versionOnce;
}

/**
 * Factory REAL de socket Baileys (@whiskeysockets/baileys), com sessão
 * persistida no banco. Carregado só pelo entrypoint do worker — os testes
 * usam factories fake.
 */
export function makeRealSocketFactory(repo: Repo): SocketFactory {
  return async (instance) => {
    const baileys = loadBaileys();
    const makeWASocket = baileys.default ?? baileys.makeWASocket;
    if (!makeWASocket) throw new Error('makeWASocket não encontrado no pacote baileys');

    const { version } = await getWaVersion();
    const { state, saveCreds } = await makeDbAuthState(repo, instance.id);
    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      // Sem `version` explícita o WhatsApp rejeita com 405 — ver resolveWaVersion().
      ...(version ? { version } : {}),
      // O QR é persistido pelo worker (baileys_auth 'qr') e servido pela API.
    });
    socket.ev.on('creds.update', (() => {
      void saveCreds();
    }) as never);
    return socket;
  };
}
