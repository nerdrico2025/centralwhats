import 'dotenv/config';
import { z } from 'zod';

/**
 * Validação de configuração por variáveis de ambiente.
 * Falhar cedo e alto é melhor que descobrir um segredo faltando em produção.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
    SQLITE_PATH: z.string().default('./wa-manager.sqlite'),
    DATABASE_URL: z.string().optional(),

    // Chave de criptografia de segredos em repouso. Obrigatória em produção.
    SECRETS_ENCRYPTION_KEY: z.string().optional(),

    // [V2] Segredo do JWT. Obrigatório em produção; default só em dev/test.
    JWT_SECRET: z.string().default('dev-secret-nao-use-em-producao'),

    // Segredo do cron de campanhas (a Vercel injeta como "Authorization:
    // Bearer <CRON_SECRET>" nas chamadas agendadas). Opcional DE PROPÓSITO no
    // schema: exigi-lo aqui derrubaria o app inteiro (inclusive o webhook) num
    // deploy sem a variável. A trava vive na rota, que recusa a varredura
    // enquanto o segredo não existir — falha alta, mas só no cron.
    CRON_SECRET: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.DB_DRIVER === 'postgres' && !val.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL é obrigatória quando DB_DRIVER=postgres',
      });
    }
    // ANTI-FALLBACK SILENCIOSO: DATABASE_URL presente com driver sqlite é
    // quase sempre um erro de digitação em DB_DRIVER (ou env que não chegou).
    // Sem esta trava, o migrate "funcionaria" no SQLite local em silêncio —
    // exatamente a categoria de bug que o CLAUDE.md proíbe.
    if (val.DATABASE_URL && val.DB_DRIVER !== 'postgres') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DB_DRIVER'],
        message:
          'DATABASE_URL está definida mas DB_DRIVER não é "postgres" ' +
          `(valor atual: "${val.DB_DRIVER}"). Defina DB_DRIVER=postgres ` +
          'ou remova DATABASE_URL — não vou cair pro SQLite em silêncio.',
      });
    }
    if (val.NODE_ENV === 'production' && !val.SECRETS_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SECRETS_ENCRYPTION_KEY'],
        message: 'SECRETS_ENCRYPTION_KEY é obrigatória em produção',
      });
    }
    if (val.NODE_ENV === 'production' && val.JWT_SECRET === 'dev-secret-nao-use-em-producao') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET é obrigatório em produção (não use o default de dev)',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Lê e valida o ambiente uma única vez (memoizado).
 * Lança com mensagem legível se algo estiver inválido.
 */
export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reseta o cache — útil em testes que mexem no process.env. */
export function resetEnvCache(): void {
  cached = null;
}
