import type { Instance } from '../repo/types';

/**
 * LOGGER DO BAILEYS — o que a lib chama de `ILogger` (lib/Utils/logger.d.ts).
 *
 * POR QUÊ existir (bug real de diagnóstico): sem `logger` no makeWASocket vale
 * o pino default da lib, que loga o erro no campo `error` — e o pino só tem
 * serializer para `err`. Como `message` e `stack` de um Error são
 * NÃO-ENUMERÁVEIS, eles somem na serialização: o log de produção virava
 * "error in handling message" cinco vezes, sem causa, sem instância, sem nada.
 * O erro real (`Connection Closed`, statusCode 428) estava disponível o tempo
 * todo — só não sobrevivia ao caminho até o log.
 *
 * Aqui o objeto chega inteiro e nós extraímos o que importa antes de imprimir.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const PESO: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

/** Superfície exigida pelo Baileys (7 membros). */
export interface ILogger {
  level: string;
  child(obj: Record<string, unknown>): ILogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface BaileysLoggerOpts {
  /** Default `warn`: em `info` o Baileys é barulhento demais (ver caça ao 405). */
  level?: LogLevel;
  /** Fechamento pedido por nós — o Set `closing` do worker. */
  intentionalClose?: () => boolean;
  /** Saída; injetável no teste. */
  sink?: (level: LogLevel, linha: string) => void;
}

/**
 * Nível default do log do Baileys. Configurável por env
 * WORKER_BAILEYS_LOG_LEVEL (trace|debug|info|warn|error).
 */
export const BAILEYS_LOG_LEVEL = (process.env.WORKER_BAILEYS_LOG_LEVEL ?? 'warn') as LogLevel;

export interface ErroExtraido {
  message: string | null;
  /** Formato Boom: `error.output.statusCode`. */
  statusCode: number | null;
  stack: string | null;
}

/**
 * Puxa o que interessa de um objeto de log da lib. Aceita `error` (o que o
 * Baileys usa) e `err` (o que o pino serializaria), porque a lib usa os dois
 * conforme o ponto do código.
 */
export function extractErro(obj: unknown): ErroExtraido {
  const campo = obj as { error?: unknown; err?: unknown } | null | undefined;
  const erro = (campo?.error ?? campo?.err) as
    | { message?: unknown; stack?: unknown; output?: { statusCode?: unknown } }
    | undefined;
  if (!erro || typeof erro !== 'object') {
    return { message: null, statusCode: null, stack: null };
  }
  const statusCode = erro.output?.statusCode;
  return {
    message: typeof erro.message === 'string' ? erro.message : null,
    statusCode: typeof statusCode === 'number' ? statusCode : null,
    stack: typeof erro.stack === 'string' ? erro.stack : null,
  };
}

/** 428 = socket já fechado. Ruído esperado quando o fechamento foi nosso. */
export function ehRuidoDeFechamento(erro: ErroExtraido): boolean {
  return erro.statusCode === 428 || (erro.message ?? '').includes('Connection Closed');
}

const sinkPadrao = (level: LogLevel, linha: string): void => {
  /* eslint-disable no-console */
  if (level === 'error') console.error(linha);
  else if (level === 'warn') console.warn(linha);
  else console.log(linha);
  /* eslint-enable no-console */
};

/**
 * Logger para UMA instância — o nome/id entram em toda linha, o que resolve
 * também o "de qual instância veio esse erro?" com várias no mesmo worker.
 */
export function makeBaileysLogger(instance: Instance, opts: BaileysLoggerOpts = {}): ILogger {
  const sink = opts.sink ?? sinkPadrao;
  const minimo = PESO[opts.level ?? BAILEYS_LOG_LEVEL] ?? PESO.warn;
  const prefixo = `[baileys ${instance.name} (${instance.id})]`;

  const emitir = (level: LogLevel, obj: unknown, msg: string | undefined, extra: string): void => {
    // Chamada estilo pino: (obj, msg) OU (msg).
    const texto = msg ?? (typeof obj === 'string' ? obj : '');
    let nivel = level;
    let detalhe = '';

    if (level === 'error' || level === 'warn') {
      const erro = extractErro(obj);
      if (erro.message || erro.statusCode != null) {
        // Fechamento que NÓS pedimos: socket morto aqui é consequência, não
        // defeito. Vira debug para não poluir o log com ruído previsível.
        if (ehRuidoDeFechamento(erro) && opts.intentionalClose?.()) nivel = 'debug';
        detalhe =
          ` | erro=${erro.message ?? '-'} statusCode=${erro.statusCode ?? '-'}` +
          (erro.stack ? `\n${erro.stack}` : '');
      }
    }
    if (PESO[nivel] < minimo) return;
    sink(nivel, `${prefixo}${extra} ${texto}${detalhe}`);
  };

  const criar = (extra: string): ILogger => ({
    level: opts.level ?? BAILEYS_LOG_LEVEL,
    child(bindings) {
      // As bindings do Baileys são pequenas (ex.: { class: 'baileys' }).
      const rotulo = Object.entries(bindings ?? {})
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ');
      return criar(rotulo ? `${extra}[${rotulo}]` : extra);
    },
    trace: (obj, msg) => emitir('trace', obj, msg, extra),
    debug: (obj, msg) => emitir('debug', obj, msg, extra),
    info: (obj, msg) => emitir('info', obj, msg, extra),
    warn: (obj, msg) => emitir('warn', obj, msg, extra),
    error: (obj, msg) => emitir('error', obj, msg, extra),
  });

  return criar('');
}
