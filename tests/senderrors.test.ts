import { describe, it, expect } from 'vitest';
import { classifySendError } from '../src/providers/classifySendError';
import { MetaApiError, TemplateParamsError } from '../src/providers/errors';
import { ownNumberFromJid } from '../src/worker/baileysWorker';

/**
 * Forma de Boom que o classificador REALMENTE consome (`output.statusCode`).
 * Construída à mão de propósito: `@hapi/boom` é dependência transitiva do
 * Baileys, não nossa — o teste não deve depender de hoisting do npm.
 */
function boom(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { output: { statusCode } });
}

/**
 * §3.5 — classificação de erro AGNÓSTICA DE PROVIDER.
 *
 * O que estes testes protegem: a decisão de retry deixa de morar em código
 * numérico da Meta espalhado na regra de negócio, e erro de Baileys para de
 * cair em `error_code: null` mudo.
 */

describe('classifySendError — Meta', () => {
  it('rate-limit (130429/131056) é o ÚNICO retryable', () => {
    for (const code of ['130429', '131056']) {
      const c = classifySendError(new MetaApiError(code, 'Rate limit hit', 429), 'meta');
      expect(c).toMatchObject({ kind: 'rate_limit', retryable: true, raw_code: code });
    }
  });

  it('número inválido (131026) é permanente', () => {
    const c = classifySendError(new MetaApiError('131026', 'Message undeliverable', 400), 'meta');
    expect(c).toMatchObject({ kind: 'invalid_recipient', retryable: false, raw_code: '131026' });
  });

  it('401/403 da Graph API é auth, nunca retryable', () => {
    for (const http of [401, 403]) {
      const c = classifySendError(new MetaApiError('190', 'Invalid token', http), 'meta');
      expect(c).toMatchObject({ kind: 'auth', retryable: false });
    }
  });

  it('variáveis de template inválidas: permanente, com o código preservado', () => {
    const c = classifySendError(new TemplateParamsError('faltou {{2}}'), 'meta');
    expect(c).toMatchObject({ retryable: false, raw_code: 'TEMPLATE_PARAMS' });
  });

  it('código desconhecido da Meta: unknown e NÃO retryable (comportamento antigo preservado)', () => {
    const c = classifySendError(new MetaApiError('999999', 'algo novo', 400), 'meta');
    expect(c).toMatchObject({ kind: 'unknown', retryable: false, raw_code: '999999' });
  });
});

describe('classifySendError — Baileys', () => {
  it('428/408/503 são transitórios e valem retry', () => {
    for (const status of [428, 408, 503]) {
      const c = classifySendError(boom('Connection Closed', status), 'baileys');
      expect(c, `statusCode ${status}`).toMatchObject({
        kind: 'transient',
        retryable: true,
        raw_code: String(status),
      });
    }
  });

  it('401/403 é auth (logout no celular) — jamais retry', () => {
    for (const status of [401, 403]) {
      const c = classifySendError(boom('Logged Out', status), 'baileys');
      expect(c).toMatchObject({ kind: 'auth', retryable: false });
    }
  });

  it('500 (All encryptions failed) fica unknown e não retenta', () => {
    const c = classifySendError(boom('All encryptions failed', 500), 'baileys');
    expect(c).toMatchObject({ kind: 'unknown', retryable: false, raw_code: '500' });
  });

  it('sessão não pareada (TypeError em creds.me.id) é auth', () => {
    const c = classifySendError(
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      'baileys',
    );
    expect(c).toMatchObject({ kind: 'auth', retryable: false, raw_code: 'NOT_PAIRED' });
  });

  it('"sem socket conectado" (erro nosso) é transitório: a varredura reconecta', () => {
    const c = classifySendError(new Error('Instância abc sem socket conectado'), 'baileys');
    expect(c).toMatchObject({ kind: 'transient', retryable: true, raw_code: 'NO_SOCKET' });
  });

  it('erro fora da tabela: unknown, não retryable, mensagem preservada', () => {
    const c = classifySendError(new Error('coisa nunca vista'), 'baileys');
    expect(c).toMatchObject({ kind: 'unknown', retryable: false });
    expect(c.message).toBe('coisa nunca vista');
  });

  it('NÃO existe rate_limit no Baileys — queda de conexão não vira rate-limit', () => {
    // Documenta a decisão (A): o protocolo não expõe rate-limit por mensagem;
    // inferi-lo de fechamento seria adivinhação.
    for (const status of [428, 408, 503, 515, 440]) {
      const c = classifySendError(boom('x', status), 'baileys');
      expect(c.kind, `statusCode ${status}`).not.toBe('rate_limit');
    }
  });

  it('MetaApiError é sempre classificado como Meta, mesmo pedindo baileys', () => {
    const c = classifySendError(new MetaApiError('130429', 'rate', 429), 'baileys');
    expect(c.kind).toBe('rate_limit');
  });
});

describe('ownNumberFromJid — número próprio da instância (§3.5)', () => {
  it('extrai só o telefone, descartando o sufixo de dispositivo', () => {
    expect(ownNumberFromJid('5511999998888:12@s.whatsapp.net')).toBe('5511999998888');
    expect(ownNumberFromJid('5511999998888@s.whatsapp.net')).toBe('5511999998888');
  });

  it('devolve null para ausente ou curto demais para ser telefone', () => {
    expect(ownNumberFromJid(null)).toBeNull();
    expect(ownNumberFromJid(undefined)).toBeNull();
    expect(ownNumberFromJid('')).toBeNull();
    expect(ownNumberFromJid(':1@s.whatsapp.net')).toBeNull();
  });
});
