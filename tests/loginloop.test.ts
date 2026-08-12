import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadApp as carregarApp, type FetchImpl } from './helpers/appSandbox';

/**
 * REGRESSÃO — "a tela de login some a cada poucos segundos, em loop".
 *
 * Bug real de produção (P6.1): os pollings do painel (Live Chat 4s, disparo de
 * campanha, QR do Baileys) fazem requests AUTENTICADAS. A limpeza deles só
 * rodava dentro de renderCurrentScreen(); quando o api.raw tomava 401 e trocava
 * a tela por renderLoginScreen() DIRETO, o timer continuava vivo. Cada tick
 * batia na API, tomava 401 de novo e remontava a tela de login POR CIMA do que
 * o Rafael estava digitando — para sempre, no ritmo do polling.
 *
 * Ficou alcançável agora porque a P6.1 criou a transição "painel aberto vira
 * trancado": criar o primeiro owner, desabilitar um usuário ou trocar a senha
 * derrubam a sessão de um painel que já está no ar.
 *
 * O teste roda o app.js DE VERDADE (sem o boot()) sobre um DOM mínimo, para
 * pegar o comportamento e não a intenção.
 */

/** Harness compartilhado (tests/helpers/appSandbox), com o que este arquivo usa. */
function loadApp(fetchImpl: FetchImpl) {
  return carregarApp({ fetchImpl, expose: ['api', 'registerCleanup', 'renderLoginScreen'] });
}

/** Resposta 401 — o sistema trancou (primeiro owner criado / sessão revogada). */
function resp401() {
  return Promise.resolve({
    status: 401,
    ok: false,
    json: () => Promise.resolve({ error: 'Não autenticado' }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('tela de login não pode ser remontada em loop', () => {
  it('REPRO: polling que 401 não remonta o login nem apaga o que foi digitado', async () => {
    const sandbox = loadApp((url) =>
      url.startsWith('/api/auth/registration-status')
        ? Promise.resolve({
            status: 200,
            ok: true,
            json: () => Promise.resolve({ bootstrap: true, public_signup: false, open: true }),
          })
        : resp401(),
    );

    // Uma tela do painel está montada e com polling ativo (Live Chat/QR/disparo).
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
      void sandbox.api.get('/api/instances/i1/conversations').catch(() => {
        /* o handler de 401 do api.raw é o que interessa aqui */
      });
    }, 100);
    sandbox.registerCleanup(() => clearInterval(timer));

    // Primeiro tick: 401 → o app cai para a tela de login.
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(ticks).toBe(1);

    // O usuário começa a digitar.
    const email = sandbox.appEl.find('E-mail');
    expect(email, 'a tela de login deveria estar montada').not.toBeNull();
    email!.value = 'rafael@clickhero.com.br';
    const senha = sandbox.appEl.find('Senha (mín. 8)')!;
    senha.value = 'minha-senha-secreta';

    // ...e o tempo passa: com o bug, o polling seguia vivo e cada tick
    // remontava a tela, zerando os campos.
    await vi.advanceTimersByTimeAsync(1000);

    expect(ticks, 'o polling tinha de ter sido parado no primeiro 401').toBe(1);
    expect(sandbox.appEl.find('E-mail')!.value).toBe('rafael@clickhero.com.br');
    expect(sandbox.appEl.find('Senha (mín. 8)')!.value).toBe('minha-senha-secreta');
  });

  it('401 repetido (requests em voo) não apaga o formulário — remontar é no-op', async () => {
    const sandbox = loadApp((url) =>
      url.startsWith('/api/auth/registration-status')
        ? Promise.resolve({
            status: 200,
            ok: true,
            json: () => Promise.resolve({ bootstrap: false, public_signup: false, open: false }),
          })
        : resp401(),
    );

    sandbox.renderLoginScreen();
    const email = sandbox.appEl.find('E-mail')!;
    email.value = 'rafael@clickhero.com.br';

    // Três requests que estavam em voo voltam 401 (cenário real: dashboard,
    // badge de não-lidas e lista de instâncias respondendo juntas).
    for (let i = 0; i < 3; i++) {
      await sandbox.api.get('/api/instances').catch(() => {});
    }

    expect(sandbox.appEl.find('E-mail')!.value).toBe('rafael@clickhero.com.br');
  });

  it('a resposta do registration-status NÃO reconstrói os campos', async () => {
    // A resposta chega alguns instantes depois de a tela abrir — bem no meio
    // da digitação. Ela só pode atualizar o rodapé.
    let liberaStatus: (() => void) | null = null;
    const statusPendente = new Promise<void>((r) => {
      liberaStatus = r;
    });

    const sandbox = loadApp((url) =>
      url.startsWith('/api/auth/registration-status')
        ? statusPendente.then(() => ({
            status: 200,
            ok: true,
            json: () => Promise.resolve({ bootstrap: true, public_signup: false, open: true }),
          }))
        : resp401(),
    );

    sandbox.renderLoginScreen();
    const email = sandbox.appEl.find('E-mail')!;
    email.value = 'rafael@clickhero.com.br'; // digitando ANTES da resposta

    liberaStatus!();
    // Esvazia a fila de microtasks: a cadeia do fetch tem vários .then().
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // O rodapé precisa ter sido atualizado (senão o teste passaria por não ter
    // acontecido nada ainda, em vez de por o formulário ter sido preservado).
    expect(sandbox.fetchCalls.map((c) => c.url)).toContain('/api/auth/registration-status');
    expect(sandbox.appEl.find('E-mail')!.value).toBe('rafael@clickhero.com.br');
  });

  it('todas as limpezas registradas rodam (a lista não descarta nenhuma)', async () => {
    const sandbox = loadApp(() => resp401());
    const rodou: string[] = [];
    sandbox.registerCleanup(() => rodou.push('livechat'));
    sandbox.registerCleanup(() => rodou.push('qr'));

    sandbox.renderLoginScreen();
    expect(rodou.sort()).toEqual(['livechat', 'qr']);
  });
});
