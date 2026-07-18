/**
 * Monta a série de volume dos últimos `days` dias a partir das linhas agregadas
 * (uma por dia+direção). Preenche dias sem mensagem com zero. Pura (sem SQL).
 */
export function buildVolumeSeries(
  rows: { d: string; direction: string; c: number }[],
  days = 30,
  now: Date = new Date(),
): { date: string; sent: number; received: number }[] {
  const byDate = new Map<string, { sent: number; received: number }>();
  for (const r of rows) {
    const e = byDate.get(r.d) ?? { sent: 0, received: 0 };
    if (r.direction === 'out') e.sent += Number(r.c);
    else e.received += Number(r.c);
    byDate.set(r.d, e);
  }

  const out: { date: string; sent: number; received: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const e = byDate.get(key) ?? { sent: 0, received: 0 };
    out.push({ date: key, sent: e.sent, received: e.received });
  }
  return out;
}
