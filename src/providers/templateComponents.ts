import { TemplateParamsError } from './errors';

/**
 * Montagem dos `components` de um template da Cloud API a partir das variáveis
 * informadas pelo chamador + a estrutura SINCRONIZADA do template (fonte da
 * verdade da Meta, tabela `templates`).
 *
 * Convenção de chaves em `vars` (uma única flat map em toda a stack — rota
 * avulsa, campanhas e fluxos usam o mesmo formato, sem migração de schema):
 *   "1", "2", "3"  → parâmetros posicionais do BODY ({{1}}, {{2}}, ...)
 *   "button0"      → parâmetro do botão de índice 0 (sufixo da URL dinâmica)
 *   "button1"      → idem para o botão de índice 1, e assim por diante
 *
 * O índice do botão é a POSIÇÃO dele na lista de botões do template (0-2),
 * exatamente como a Graph API exige.
 */

/** Chave de variável de botão: button0, button1, ... (case-insensitive). */
const BUTTON_VAR_KEY = /^button(\d+)$/i;

/** Placeholder de variável da Meta: {{1}}, {{ 2 }}, ... */
const PLACEHOLDER = /\{\{\s*\d+\s*\}\}/;

export interface SplitVars {
  /** Variáveis posicionais do BODY. */
  bodyVars: Record<string, string>;
  /** Variáveis de botão, indexadas pela posição do botão ("0", "1", ...). */
  buttonVars: Record<string, string>;
}

/**
 * Separa as variáveis de BODY das de botão. Sem isso, uma chave "button0"
 * entraria como parâmetro do body (ordenação numérica viraria NaN) e a Meta
 * rejeitaria o envio por contagem de parâmetros.
 */
export function splitTemplateVars(vars?: Record<string, string>): SplitVars {
  const bodyVars: Record<string, string> = {};
  const buttonVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars ?? {})) {
    const match = BUTTON_VAR_KEY.exec(key);
    if (match) buttonVars[match[1]] = value;
    else bodyVars[key] = value;
  }
  return { bodyVars, buttonVars };
}

interface RawButton {
  type?: unknown;
  url?: unknown;
}

/** Extrai a lista de botões do component BUTTONS dos components sincronizados. */
function findButtons(components: unknown): RawButton[] | null {
  if (!Array.isArray(components)) return null;
  for (const comp of components) {
    if (!comp || typeof comp !== 'object') continue;
    const c = comp as { type?: unknown; buttons?: unknown };
    if (String(c.type).toUpperCase() === 'BUTTONS' && Array.isArray(c.buttons)) {
      return c.buttons as RawButton[];
    }
  }
  return null;
}

/** Um botão exige parâmetro só se for URL E tiver placeholder no sufixo. */
function isDynamicUrlButton(btn: RawButton): boolean {
  return String(btn.type).toUpperCase() === 'URL' && PLACEHOLDER.test(String(btn.url ?? ''));
}

function buttonComponent(index: string, value: string): Record<string, unknown> {
  // Formato exigido pela Graph API. `index` é STRING ("0".."2").
  return {
    type: 'button',
    sub_type: 'url',
    index,
    parameters: [{ type: 'text', text: value }],
  };
}

/**
 * Monta os components de botão do payload de envio.
 *
 * - Botão estático (URL sem placeholder), quick_reply, copy_code etc. → NENHUM
 *   component é gerado (mandar um sobrando também dá 132000).
 * - Botão de URL dinâmica sem a variável correspondente → TemplateParamsError.
 *   Nunca "chutamos" um valor nem mandamos payload malformado em silêncio.
 * - Template ainda não sincronizado (components ausentes): confiamos nas
 *   variáveis informadas, mesmo critério do resolveTemplateLanguage.
 */
export function buildButtonComponents(
  components: unknown,
  buttonVars: Record<string, string>,
  templateName: string,
): Record<string, unknown>[] {
  const buttons = findButtons(components);

  // Sem estrutura sincronizada: não dá para validar — usa o que foi informado.
  if (!buttons) {
    return Object.keys(buttonVars)
      .sort((a, b) => Number(a) - Number(b))
      .map((index) => buttonComponent(index, buttonVars[index]));
  }

  const out: Record<string, unknown>[] = [];
  const consumed = new Set<string>();

  buttons.forEach((btn, position) => {
    if (!isDynamicUrlButton(btn)) return;
    const index = String(position);
    const value = buttonVars[index];
    if (value === undefined || value === '') {
      throw new TemplateParamsError(
        `Template "${templateName}": o botão de índice ${index} tem URL dinâmica e exige ` +
          `a variável "button${index}", que não foi informada.`,
      );
    }
    consumed.add(index);
    out.push(buttonComponent(index, value));
  });

  // Variável de botão que não casa com nenhum botão dinâmico: quase sempre é
  // índice errado. Falhar aqui é melhor que tomar 132000 opaco da Meta.
  for (const index of Object.keys(buttonVars)) {
    if (!consumed.has(index)) {
      throw new TemplateParamsError(
        `Template "${templateName}": foi informada a variável "button${index}", mas o ` +
          `template não tem botão de URL dinâmica nesse índice.`,
      );
    }
  }

  return out;
}
