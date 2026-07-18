import { createRequire } from 'node:module';
import type { Repo } from '../repo';

/**
 * Auth state do Baileys persistido no BANCO (tabela baileys_auth) — a sessão
 * sobrevive a restart do worker (nunca em memória volátil, nunca em arquivo
 * local que some no redeploy).
 *
 * Equivalente ao useMultiFileAuthState do Baileys, com BufferJSON para
 * preservar os Buffers das credenciais.
 */

// Lazy require: o pacote só carrega quando o worker realmente roda.
const nodeRequire = createRequire(__filename);

interface BaileysLib {
  initAuthCreds: () => Record<string, unknown>;
  BufferJSON: {
    replacer: (k: string, v: unknown) => unknown;
    reviver: (k: string, v: unknown) => unknown;
  };
  proto: {
    Message: {
      AppStateSyncKeyData: { fromObject: (o: unknown) => unknown };
    };
  };
}

export interface DbAuthState {
  state: {
    creds: Record<string, unknown>;
    keys: {
      get(type: string, ids: string[]): Promise<Record<string, unknown>>;
      set(data: Record<string, Record<string, unknown | null>>): Promise<void>;
    };
  };
  saveCreds: () => Promise<void>;
}

export async function makeDbAuthState(repo: Repo, instanceId: string): Promise<DbAuthState> {
  const { initAuthCreds, BufferJSON, proto } = nodeRequire(
    '@whiskeysockets/baileys',
  ) as BaileysLib;

  // Serialização em duas camadas: BufferJSON.replacer preserva Buffers; o
  // repo guarda a string resultante como valor JSON.
  const write = async (key: string, value: unknown): Promise<void> => {
    await repo.baileysAuth.set(instanceId, key, JSON.stringify(value, BufferJSON.replacer));
  };
  const read = async (key: string): Promise<unknown | null> => {
    const raw = await repo.baileysAuth.get(instanceId, key);
    if (raw == null) return null;
    return JSON.parse(String(raw), BufferJSON.reviver);
  };

  const creds =
    ((await read('creds')) as Record<string, unknown> | null) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const out: Record<string, unknown> = {};
          for (const id of ids) {
            let value = await read(`key:${type}:${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value != null) out[id] = value;
          }
          return out;
        },
        async set(data) {
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              const key = `key:${type}:${id}`;
              if (value == null) await repo.baileysAuth.delete(instanceId, key);
              else await write(key, value);
            }
          }
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}
