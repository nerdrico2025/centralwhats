import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { loadEnv } from '../config';

/**
 * Validação da assinatura do webhook da Meta (X-Hub-Signature-256).
 *
 * POR QUE: o verify_token protege só o GET de verificação. O POST de eventos
 * reais não tinha checagem NENHUMA de origem — qualquer um com a URL podia
 * fabricar uma "mensagem recebida" com remetente e texto arbitrários. Com um
 * fluxo de chatbot ativo, isso vira ENVIO REAL de mensagem (custo na conta
 * Meta) e dado falso em contacts/messages/crm_contacts.
 *
 * COMO: a Meta assina o corpo BRUTO de cada POST com HMAC-SHA256 usando o App
 * Secret (segredo por App Meta — não é o verify_token nem o token de acesso da
 * instância) e manda no header como "sha256=<hex>".
 */

/** O raw body capturado no parser (ver captureRawBody). */
interface ComRawBody {
  rawBody?: Buffer;
}

/**
 * `verify` do express.json: guarda os bytes ORIGINAIS antes do parse.
 *
 * Sem isto o HMAC seria calculado sobre um JSON.stringify do objeto já
 * parseado — que quase nunca reproduz os bytes exatos que a Meta assinou
 * (ordem de chaves, espaços, escapes unicode). A assinatura falharia sempre,
 * e a "correção" natural seria desligar a validação.
 */
export function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  if (buf && buf.length) (req as Request & ComRawBody).rawBody = buf;
}

/** Compara dois hex de mesmo tamanho sem vazar o prefixo correto por tempo. */
function hexesConferem(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false; // hex malformado
  }
}

export type AssinaturaFalha =
  | 'sem_segredo'
  | 'header_ausente'
  | 'header_malformado'
  | 'sem_raw_body'
  | 'nao_confere';

export interface AssinaturaResultado {
  ok: boolean;
  reason?: AssinaturaFalha;
}

/** Núcleo testável: decide se a requisição é legitimamente da Meta. */
export function verificarAssinatura(
  rawBody: Buffer | undefined,
  header: string | undefined,
  appSecret: string | undefined,
): AssinaturaResultado {
  // FAIL-CLOSED: sem segredo configurado não há como distinguir a Meta de um
  // atacante, então nada é processado. O contrário — aceitar tudo quando falta
  // a variável — deixaria o buraco aberto exatamente no cenário mais provável
  // (deploy novo com a env var esquecida).
  if (!appSecret) return { ok: false, reason: 'sem_segredo' };
  if (!header) return { ok: false, reason: 'header_ausente' };

  const [algo, recebido] = header.split('=');
  if (algo !== 'sha256' || !recebido) return { ok: false, reason: 'header_malformado' };
  if (!rawBody) return { ok: false, reason: 'sem_raw_body' };

  const esperado = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return hexesConferem(recebido.trim().toLowerCase(), esperado)
    ? { ok: true }
    : { ok: false, reason: 'nao_confere' };
}

/** Frase acionável por motivo — recusa nunca pode ser silenciosa. */
export function mensagemDeFalha(reason: AssinaturaFalha): string {
  switch (reason) {
    case 'sem_segredo':
      return 'META_APP_SECRET não configurado — o webhook recusa TODO evento até a variável existir. Pegue o App Secret no Meta App Dashboard (Configurações do app → Básico) e defina na Vercel.';
    case 'header_ausente':
      return 'requisição sem X-Hub-Signature-256 — não veio da Meta (ou veio de um cliente que não assina)';
    case 'header_malformado':
      return 'X-Hub-Signature-256 fora do formato esperado "sha256=<hex>"';
    case 'sem_raw_body':
      return 'corpo bruto indisponível para calcular o HMAC (body vazio ou parser sem captureRawBody)';
    case 'nao_confere':
      return 'assinatura NÃO confere: corpo adulterado em trânsito ou App Secret diferente do configurado na Meta';
    default:
      return 'motivo desconhecido';
  }
}

/**
 * Middleware do POST /webhook. Recusa com 401 e log claro; NÃO chama next(),
 * então o payload jamais chega ao processamento.
 *
 * Só o POST usa isto: o GET de verificação não é assinado pela Meta desse
 * jeito e continua validando pelo verify_token.
 */
export function requireMetaSignature(): RequestHandler {
  return (req, res, next) => {
    const r = verificarAssinatura(
      (req as Request & ComRawBody).rawBody,
      req.header('x-hub-signature-256'),
      loadEnv().META_APP_SECRET,
    );
    if (r.ok) {
      next();
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(`[webhook] POST RECUSADO — ${mensagemDeFalha(r.reason!)}`);
    // 401 sem detalhe no corpo: quem não assina não precisa saber o porquê.
    res.status(401).json({ error: 'Assinatura inválida' });
  };
}
