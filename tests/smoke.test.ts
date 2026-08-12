import { describe, it, expect } from 'vitest';
import { getProvider, MetaCloudProvider, BaileysProvider } from '../src/providers';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';

describe('smoke', () => {
  it('soma trivial (setup de teste vivo)', () => {
    expect(1 + 1).toBe(2);
  });
});

describe('provider dispatcher', () => {
  it('escolhe MetaCloudProvider para provider_type=meta', () => {
    const p = getProvider({ provider_type: 'meta' });
    expect(p).toBeInstanceOf(MetaCloudProvider);
    expect(p.type).toBe('meta');
    expect(p.capabilities.template).toBe(true);
  });

  it('escolhe BaileysProvider (com transporte) e marca template/cta=false', () => {
    const fakeSender = { send: async () => ({ waMessageId: null, status: 'queued' as const }) };
    const p = getProvider({ provider_type: 'baileys' }, { baileysSender: fakeSender });
    expect(p).toBeInstanceOf(BaileysProvider);
    expect(p.type).toBe('baileys');
    expect(p.capabilities.template).toBe(false);
    expect(p.capabilities.cta).toBe(false);
  });

  it('Baileys sem transporte injetado → erro claro (web usa outbox; worker, socket)', () => {
    expect(() => getProvider({ provider_type: 'baileys' })).toThrow(/transporte/);
  });
});

describe('repo adapter (sqlite in-memory)', () => {
  it('expõe todos os sub-repos e roda migrations limpas', async () => {
    const repo = createSqliteAdapter({ path: ':memory:' });
    await repo.migrate();
    expect(repo.instances).toBeDefined();
    expect(repo.flowNodeCounters).toBeDefined();
    await expect(repo.instances.listAll()).resolves.toEqual([]);
    await repo.close();
  });
});
