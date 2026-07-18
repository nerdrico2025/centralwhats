import { describe, it, expect } from 'vitest';
import { normalizePhone } from '../src/util/phone';

describe('normalizePhone', () => {
  it('mantém só dígitos', () => {
    expect(normalizePhone('+55 (11) 99999-8888')).toBe('5511999998888');
    expect(normalizePhone('  5511999998888  ')).toBe('5511999998888');
  });

  it('remove prefixo internacional 00', () => {
    expect(normalizePhone('0055 11 99999-8888')).toBe('5511999998888');
  });

  it('formatos diferentes do mesmo número colidem no mesmo valor', () => {
    const a = normalizePhone('+55 11 99999-8888');
    const b = normalizePhone('5511999998888');
    expect(a).toBe(b);
  });

  it('rejeita telefone vazio/curto', () => {
    expect(() => normalizePhone('')).toThrow();
    expect(() => normalizePhone('123')).toThrow();
  });
});
