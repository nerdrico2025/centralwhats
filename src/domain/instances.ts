import type { Repo } from '../repo';
import type { Instance } from '../repo/types';

/**
 * Resolvedor de instância pelo phone_number_id do payload.
 *
 * REGRA (CLAUDE.md / plano §5): o webhook identifica a instância pelo
 * phone_number_id que vem NO PAYLOAD da Meta — nunca pela URL. Esta função é
 * o ponto único desse mapeamento; o handler do webhook (P1.2) chama aqui.
 *
 * Módulo puro de /domain: recebe o repo por parâmetro, sem dependência de HTTP.
 */
export async function resolveInstanceByPhoneNumberId(
  repo: Repo,
  phoneNumberId: string,
): Promise<Instance | null> {
  if (!phoneNumberId) return null;
  return repo.instances.getByPhoneNumberId(phoneNumberId);
}
