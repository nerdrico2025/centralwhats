import { createRequire } from 'node:module';
import type { Repo } from '../repo';
import { makeDbAuthState } from './dbAuthState';
import type { BaileysSocketLike, SocketFactory } from './baileysWorker';

const nodeRequire = createRequire(__filename);

/**
 * Factory REAL de socket Baileys (@whiskeysockets/baileys), com sessão
 * persistida no banco. Carregado só pelo entrypoint do worker — os testes
 * usam factories fake.
 */
export function makeRealSocketFactory(repo: Repo): SocketFactory {
  return async (instance) => {
    const baileys = nodeRequire('@whiskeysockets/baileys') as {
      default?: (opts: unknown) => BaileysSocketLike;
      makeWASocket?: (opts: unknown) => BaileysSocketLike;
    };
    const makeWASocket = baileys.default ?? baileys.makeWASocket;
    if (!makeWASocket) throw new Error('makeWASocket não encontrado no pacote baileys');

    const { state, saveCreds } = await makeDbAuthState(repo, instance.id);
    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      // O QR é persistido pelo worker (baileys_auth 'qr') e servido pela API.
    });
    socket.ev.on('creds.update', (() => {
      void saveCreds();
    }) as never);
    return socket;
  };
}
