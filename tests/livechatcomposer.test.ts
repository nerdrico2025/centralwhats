import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flush, json200, loadApp, type FakeEl, type Sandbox } from './helpers/appSandbox';

/**
 * REGRESSÃO — "o texto some do composer do Live Chat enquanto digito".
 *
 * Mesma família do bug da tela de login (90a1dbc): trabalho periódico
 * redesenhando por cima da entrada do usuário. Aqui o polling de 4s chamava
 * loadMessages() → renderConversation(), que fazia `rightEl.innerHTML = ''` e
 * remontava a árvore INTEIRA — inclusive um <textarea> novo. A cada tick o
 * texto digitado e o foco iam junto.
 *
 * Invariante que este arquivo protege: enquanto a conversa aberta é a mesma, o
 * nó do composer é o MESMO nó — o polling atualiza só a lista de mensagens.
 */

const CONVERSA = {
  phone: '5511999998888',
  name: 'Cliente',
  unread: 0,
  last_message_at: '2026-08-11T12:00:00.000Z',
  last_message_direction: 'in',
  last_message_type: 'text',
  last_message_content: { body: 'oi' },
};

/** Mensagens que o servidor devolve; cresce a cada tick (o poll faz efeito). */
let mensagens: { id: string; direction: string; type: string; content: unknown; created_at: string }[];

function msg(i: number) {
  return {
    id: `m${i}`,
    direction: i % 2 ? 'out' : 'in',
    type: 'text',
    content: { body: `mensagem ${i}` },
    created_at: '2026-08-11T12:00:00.000Z',
  };
}

function montarSandbox(): Sandbox {
  return loadApp({
    expose: ['api', 'livechatScreen', 'registerCleanup'],
    fetchImpl: (url) => {
      if (url.includes('/conversations/') && url.includes('/messages')) {
        return Promise.resolve(json200(mensagens));
      }
      if (url.endsWith('/conversations')) return Promise.resolve(json200([CONVERSA]));
      if (url.includes('/read')) return Promise.resolve(json200({ ok: true }));
      if (url.endsWith('/messages')) return Promise.resolve(json200({ id: 'novo' }));
      return Promise.resolve(json200([]));
    },
  });
}

/** Abre a tela, seleciona a conversa e devolve o composer. */
async function abrirConversa(sandbox: Sandbox): Promise<{ root: FakeEl; input: FakeEl }> {
  sandbox.api.currentInstanceId = 'i1';
  const root = sandbox.livechatScreen() as FakeEl;
  await flush();

  // Clica na conversa da lista (mesmo caminho do usuário).
  const item = root.query((el) => el.className.includes('conv-item'));
  expect(item, 'a conversa deveria aparecer na lista').not.toBeNull();
  item!.fire('click');
  await flush();

  const input = root.find('Digite uma mensagem…');
  expect(input, 'o composer deveria estar montado').not.toBeNull();
  return { root, input: input! };
}

beforeEach(() => {
  vi.useFakeTimers();
  mensagens = [msg(1), msg(2)];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('composer do Live Chat não pode ser destruído pelo polling', () => {
  it('REPRO: digitar uma mensagem longa sobrevive a vários ciclos de polling', async () => {
    const sandbox = montarSandbox();
    const { root, input } = await abrirConversa(sandbox);

    // O usuário digita — devagar, como gente: o polling (4s) passa VÁRIAS
    // vezes no meio da digitação.
    const trechos = [
      'Bom dia! Sobre a vaga que conversamos ontem, ',
      'consegui confirmar com o time que a posição segue aberta ',
      'e o processo continua na etapa de entrevista. ',
      'Posso te mandar o link do grupo agora?',
    ];
    let digitado = '';
    for (const [i, trecho] of trechos.entries()) {
      digitado += trecho;
      input.value = digitado;
      // Chega mensagem nova do outro lado enquanto ele digita.
      mensagens = [...mensagens, msg(10 + i)];
      await vi.advanceTimersByTimeAsync(4000); // um tick inteiro do polling
      await flush();

      expect(
        root.find('Digite uma mensagem…')?.value,
        `o texto sumiu depois do tick ${i + 1}`,
      ).toBe(digitado);
    }

    // E é literalmente o MESMO nó — não um recriado com o valor restaurado
    // (nó novo perderia foco e posição do cursor).
    expect(root.find('Digite uma mensagem…')).toBe(input);
    expect(input.value).toBe(trechos.join(''));
  });

  it('o polling REALMENTE atualiza a lista de mensagens (não passou por não fazer nada)', async () => {
    const sandbox = montarSandbox();
    const { root } = await abrirConversa(sandbox);

    const bolhas = () => root.queryAll((el) => el.className.startsWith('bubble bubble--')).length;
    const antes = bolhas();
    expect(antes).toBe(2);

    mensagens = [...mensagens, msg(3), msg(4)];
    await vi.advanceTimersByTimeAsync(4000);
    await flush();

    expect(bolhas()).toBe(4); // o tick trouxe as novas
  });

  it('trocar de conversa recria o composer (rascunho não vaza entre contatos)', async () => {
    const sandbox = montarSandbox();
    const { root, input } = await abrirConversa(sandbox);
    input.value = 'rascunho do contato A';

    // Seleciona outra conversa pelo mesmo caminho interno do clique.
    const item = root.query((el) => el.className.includes('conv-item'))!;
    // Simula a lista trazendo outro contato e o usuário clicando nele.
    (sandbox.api as { currentInstanceId: string }).currentInstanceId = 'i1';
    item.fire('click'); // mesma conversa: NÃO pode remontar
    await flush();
    expect(root.find('Digite uma mensagem…')).toBe(input);
    expect(input.value).toBe('rascunho do contato A');
  });

  it('falha de rede no tick mostra o erro SEM apagar o que está digitado', async () => {
    const sandbox = montarSandbox();
    const { root, input } = await abrirConversa(sandbox);
    input.value = 'mensagem que não pode sumir';

    // O próximo tick falha ao buscar o histórico.
    mensagens = [];
    const original = sandbox.api.get;
    (sandbox.api as { get: unknown }).get = (path: string) =>
      path.includes('/messages')
        ? Promise.reject(new Error('rede caiu'))
        : (original as (p: string) => Promise<unknown>)(path);

    await vi.advanceTimersByTimeAsync(4000);
    await flush();

    expect(root.find('Digite uma mensagem…')).toBe(input);
    expect(input.value).toBe('mensagem que não pode sumir');
  });
});
