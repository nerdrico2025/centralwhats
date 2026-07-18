/**
 * Normalização de telefone — FUNÇÃO ÚNICA usada por todo o repo de contatos e
 * mensagens (CLAUDE.md: "Telefone sempre normalizado antes de gravar/comparar").
 *
 * Regra conservadora e determinística: mantém apenas dígitos, no formato
 * internacional sem '+' (como o WhatsApp usa). Não injeta código de país nem
 * mexe no 9º dígito — suposições assim já causaram bug de comparação. Quem
 * precisar de país default resolve na borda, antes de chamar aqui.
 *
 * Exemplos:
 *   "+55 (11) 99999-8888" -> "5511999998888"
 *   "0055 11 99999-8888"  -> "5511999998888"  (prefixo internacional 00 removido)
 *   "  5511999998888  "   -> "5511999998888"
 */
export function normalizePhone(raw: string): string {
  if (raw == null) {
    throw new Error('normalizePhone: telefone vazio');
  }
  let digits = String(raw).replace(/\D+/g, '');
  // Prefixo de discagem internacional "00" (ex.: 0055...) → remove.
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  if (digits.length < 8) {
    throw new Error(`normalizePhone: telefone inválido (${raw})`);
  }
  return digits;
}
