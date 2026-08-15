import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Repo } from '../repo';
import type { UserRole } from '../repo/types';
import { hashApiKey, looksLikeApiKey, maskApiKey } from '../util/auth';
import type { AuthInfo } from './util';

/**
 * AUTENTICAÇÃO POR CHAVE DE SERVIÇO (máquina-a-máquina) — [P6.3].
 *
 * Roda ANTES do middleware de JWT e só intercepta o que reconhece pelo
 * prefixo `cw_live_`. Todo o resto (login de usuário, modo bootstrap) segue
 * intocado para o fluxo de sempre.
 *
 * TRÊS TRAVAS, e a ordem importa:
 *
 *  1. LISTA BRANCA DE ROTAS (deny-by-default). Uma chave só alcança o que está
 *     em ROTAS_PERMITIDAS. Rota nova NÃO fica exposta por esquecimento — fica
 *     fechada por omissão, que é o lado certo de errar.
 *  2. ESCOPO DE ORG. O `orgId` vem da CHAVE, nunca da requisição, e é entregue
 *     ao `requireInstance()` — o gargalo único de isolamento que já existe.
 *     Não há chave global: `org_id` é NOT NULL no schema.
 *  3. ESCOPO DE INSTÂNCIA. Se a chave nasceu presa a uma instância, qualquer
 *     outra responde 404 — o MESMO 404 do cross-org, para não vazar nem a
 *     existência da instância alheia.
 *
 * O papel concedido é o MÍNIMO daquela rota (coluna `role` da lista), e hoje
 * isso significa SEMPRE `agent`: chave de serviço nunca recebe `owner` — ver
 * a invariante em ROTAS_PERMITIDAS.
 */

/** Rota liberada para chave de serviço + papel mínimo que ela exige. */
interface RotaPermitida {
  method: string;
  /** Casa o caminho DENTRO do router /api e captura o instance_id no grupo 1. */
  re: RegExp;
  role: UserRole;
  descricao: string;
}

/**
 * INVARIANTE: nenhuma entrada aqui pode ter `role: 'owner'`.
 *
 * Chave de serviço é sempre `agent` — privilégio mínimo absoluto. Foi por
 * isso que `GET /templates` saiu desta lista: aquele mount é `ownerOnly`, e
 * incluí-lo obrigaria a chave a carregar `owner` só para consultar
 * sincronização. Quem envia não precisa disso: se o template não estiver
 * sincronizado, o próprio envio devolve 400 dizendo exatamente isso.
 *
 * Há teste travando esta invariante — ver tests/apikeys.test.ts.
 */
export const ROTAS_PERMITIDAS: RotaPermitida[] = [
  {
    method: 'POST',
    re: /^\/instances\/([^/]+)\/messages\/?$/,
    role: 'agent', // envio não é rota de gestão (mount ownerOnly: false)
    descricao: 'POST /api/instances/:id/messages',
  },
];

/** Compara dois hashes hex sem vazar o prefixo correto por tempo. */
function hashesConferem(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false; // hex malformado
  }
}

/** Rota casada para (método, caminho), ou null se não está na lista branca. */
export function rotaPermitida(
  method: string,
  path: string,
): { rota: RotaPermitida; instanceId: string } | null {
  for (const rota of ROTAS_PERMITIDAS) {
    if (rota.method !== method) continue;
    const match = rota.re.exec(path);
    if (match) return { rota, instanceId: match[1] };
  }
  return null;
}

/**
 * Middleware. Montado dentro do router `/api`, ANTES do de JWT.
 *
 * Uma vez reconhecida como chave de serviço, a requisição NUNCA cai no fluxo
 * de JWT: ela é aceita aqui ou recusada aqui. Deixá-la seguir produziria um
 * 401 confuso ("token inválido") para quem mandou uma chave perfeitamente
 * válida numa rota não liberada.
 */
export function createApiKeyMiddleware(repo: Repo) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        next();
        return;
      }
      const bruta = header.slice(7).trim();
      if (!looksLikeApiKey(bruta)) {
        next(); // JWT de usuário — fluxo de sempre, sem alteração
        return;
      }

      // (1) Lista branca ANTES de qualquer acesso ao banco: rota não liberada
      // não vira sequer uma consulta.
      const alvo = rotaPermitida(req.method, req.path);
      if (!alvo) {
        // eslint-disable-next-line no-console
        console.warn(
          `[api-key] rota não liberada para chave de serviço: ${req.method} ${req.path} ` +
            `(chave ${maskApiKey(bruta)})`,
        );
        res.status(403).json({
          error: 'Esta chave de serviço não tem acesso a esta rota',
          allowed: ROTAS_PERMITIDAS.map((r) => r.descricao),
        });
        return;
      }

      const hash = hashApiKey(bruta);
      const chave = await repo.apiKeys.getByKeyHash(hash);

      // Inexistente e revogada dão a MESMA resposta ao cliente; o log
      // distingue as duas para quem está diagnosticando do lado de cá.
      if (!chave || !hashesConferem(hash, chave.key_hash)) {
        // eslint-disable-next-line no-console
        console.warn(`[api-key] chave desconhecida: ${maskApiKey(bruta)}`);
        res.status(401).json({ error: 'Chave de API inválida' });
        return;
      }
      if (chave.revoked_at) {
        // eslint-disable-next-line no-console
        console.warn(
          `[api-key] chave REVOGADA em ${chave.revoked_at} tentou usar: ` +
            `${chave.label} (${chave.id})`,
        );
        res.status(401).json({ error: 'Chave de API inválida' });
        return;
      }

      // (3) Escopo de instância. Mesmo 404 do cross-org: quem tem chave de
      // outra instância não descobre daqui se ela existe.
      if (chave.instance_id && chave.instance_id !== alvo.instanceId) {
        // eslint-disable-next-line no-console
        console.warn(
          `[api-key] chave ${chave.label} (${chave.id}) é da instância ` +
            `${chave.instance_id} e tentou a ${alvo.instanceId}`,
        );
        res.status(404).json({ error: 'Instância não encontrada' });
        return;
      }

      // (2) O escopo de org entra aqui e vale para o resto da requisição:
      // requireInstance() faz o isolamento sem que a rota saiba de nada disto.
      const auth: AuthInfo = {
        userId: null, // não há usuário: é sistema
        orgId: chave.org_id,
        role: alvo.rota.role,
      };
      (req as Request & { auth?: AuthInfo }).auth = auth;
      (req as Request & { apiKeyId?: string }).apiKeyId = chave.id;

      // Carimbo de uso FORA do caminho da resposta (best-effort, por desenho:
      // é dado de auditoria, não de negócio — falhar aqui não pode derrubar um
      // envio legítimo).
      void repo.apiKeys.touchLastUsed(chave.id, new Date().toISOString()).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[api-key] falha ao gravar last_used_at de ${chave.id}:`, err);
      });

      next();
    })().catch((err) => {
      // Falha de banco na autenticação: recusa (fail-closed) e loga alto.
      // eslint-disable-next-line no-console
      console.error('[api-key] erro ao autenticar chave de serviço:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erro ao autenticar a chave de API' });
      }
    });
  };
}
