import type { Repo } from '../repo';
import type { Instance, Template } from '../repo/types';
import {
  fetchMetaTemplates,
  type MetaTemplatesOptions,
} from '../providers/metaTemplates';

/** Erro de resolução de idioma de template (evita mismatch silencioso). */
export class TemplateResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateResolutionError';
  }
}

/**
 * Sincroniza os templates aprovados/registrados da WABA para repo.templates.
 * O idioma vem EXATO da Meta e é a fonte da verdade para o envio depois.
 */
export async function syncTemplates(
  repo: Repo,
  instance: Instance,
  deps: MetaTemplatesOptions = {},
): Promise<{ synced: number; templates: Template[] }> {
  const raw = await fetchMetaTemplates(instance, deps);
  const templates: Template[] = [];
  for (const t of raw) {
    const saved = await repo.templates.upsert({
      instance_id: instance.id,
      name: t.name,
      category: t.category,
      language: t.language, // idioma cadastrado na Meta — nunca assumir pt_BR
      status: t.status,
      components: t.components ?? null,
      wa_template_id: t.id,
    });
    templates.push(saved);
  }
  return { synced: templates.length, templates };
}

/**
 * Resolve o idioma a usar no envio de um template, a partir dos registros
 * SINCRONIZADOS (fonte da verdade). Nunca cai em pt_BR default.
 *
 *  - language informado + existe registro para (name, language) → usa.
 *  - language informado mas o name tem registros e NENHUM nesse idioma →
 *    erro (mismatch: a Meta não tem esse idioma; rejeitaria em silêncio).
 *  - language informado e o name não tem registro sincronizado → confia no
 *    informado (pode ainda não ter sido sincronizado localmente).
 *  - sem language: 1 idioma sincronizado → usa; 0 → erro (informe/sincronize);
 *    vários → erro pedindo para especificar (não escolhe em silêncio).
 */
export async function resolveTemplateLanguage(
  repo: Repo,
  instance: Instance,
  name: string,
  language?: string,
): Promise<string> {
  const all = (await repo.templates.list(instance.id)).filter((t) => t.name === name);

  if (language) {
    if (all.length > 0 && !all.some((t) => t.language === language)) {
      const disponiveis = all.map((t) => t.language).join(', ');
      throw new TemplateResolutionError(
        `Template "${name}" não tem o idioma "${language}" cadastrado na Meta ` +
          `(disponíveis: ${disponiveis}).`,
      );
    }
    return language;
  }

  if (all.length === 0) {
    throw new TemplateResolutionError(
      `Template "${name}" não sincronizado. Informe o idioma ou rode o sync.`,
    );
  }
  if (all.length === 1) {
    return all[0].language;
  }
  const disponiveis = all.map((t) => t.language).join(', ');
  throw new TemplateResolutionError(
    `Template "${name}" tem múltiplos idiomas (${disponiveis}). Especifique qual usar.`,
  );
}
