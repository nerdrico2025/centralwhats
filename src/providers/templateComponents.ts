import { TemplateParamsError } from './errors';

/**
 * Montagem dos `components` de um template da Cloud API a partir das variáveis
 * informadas pelo chamador + a estrutura SINCRONIZADA do template (fonte da
 * verdade da Meta, tabela `templates`).
 *
 * Convenção de chaves em `vars` (uma única flat map em toda a stack — rota
 * avulsa, campanhas e fluxos usam o mesmo formato, sem migração de schema):
 *   "1", "2", "3"          → parâmetros posicionais do BODY ({{1}}, {{2}}, ...)
 *   "button0"              → parâmetro do botão de índice 0 (sufixo da URL)
 *   "button1"              → idem para o botão de índice 1, e assim por diante
 *   "header"               → valor do header TEXT dinâmico
 *   "headerMedia"          → URL pública da mídia do header
 *   "headerMediaId"        → alternativa: id de mídia já subida à Meta
 *   "headerMediaType"      → image|video|document (só se não sincronizado)
 *   "headerMediaFilename"  → nome do arquivo, só para header DOCUMENT
 *
 * O índice do botão é a POSIÇÃO dele na lista de botões do template (0-2),
 * exatamente como a Graph API exige. Header é único por template, por isso não
 * tem índice.
 */

/** Chave de variável de botão: button0, button1, ... (case-insensitive). */
const BUTTON_VAR_KEY = /^button(\d+)$/i;

/** Placeholder de variável da Meta: {{1}}, {{ 2 }}, ... */
const PLACEHOLDER = /\{\{\s*\d+\s*\}\}/;

/** Variáveis do HEADER, já normalizadas a partir das chaves reservadas. */
export interface HeaderVars {
  /** Header TEXT dinâmico ({{1}} no header). Chave `header`. */
  text?: string;
  /** URL pública da mídia do header. Chave `headerMedia`. */
  mediaLink?: string;
  /** Id de mídia já subida à Meta. Chave `headerMediaId`. */
  mediaId?: string;
  /** image|video|document — só necessário se o template não foi sincronizado. */
  mediaType?: string;
  /** Nome do arquivo, só para header DOCUMENT. Chave `headerMediaFilename`. */
  filename?: string;
}

export interface SplitVars {
  /** Variáveis posicionais do BODY. */
  bodyVars: Record<string, string>;
  /** Variáveis de botão, indexadas pela posição do botão ("0", "1", ...). */
  buttonVars: Record<string, string>;
  /** Variáveis do header (só existe um header por template). */
  headerVars: HeaderVars;
}

/** Chaves reservadas do header → campo em HeaderVars (comparação lowercase). */
const HEADER_VAR_KEYS: Record<string, keyof HeaderVars> = {
  header: 'text',
  headermedia: 'mediaLink',
  headermediaid: 'mediaId',
  headermediatype: 'mediaType',
  headermediafilename: 'filename',
};

/**
 * Separa as variáveis de BODY das de botão e de header. Sem isso, uma chave
 * "button0"/"header" entraria como parâmetro do body (a ordenação numérica
 * viraria NaN) e a Meta rejeitaria o envio por contagem de parâmetros.
 */
export function splitTemplateVars(vars?: Record<string, string>): SplitVars {
  const bodyVars: Record<string, string> = {};
  const buttonVars: Record<string, string> = {};
  const headerVars: HeaderVars = {};
  for (const [key, value] of Object.entries(vars ?? {})) {
    const headerField = HEADER_VAR_KEYS[key.toLowerCase()];
    if (headerField) {
      headerVars[headerField] = value;
      continue;
    }
    const match = BUTTON_VAR_KEY.exec(key);
    if (match) buttonVars[match[1]] = value;
    else bodyVars[key] = value;
  }
  return { bodyVars, buttonVars, headerVars };
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

// --------------------------------------------------------------------- HEADER

const MEDIA_FORMATS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);

interface RawHeader {
  format?: unknown;
  text?: unknown;
}

/** Localiza o component HEADER nos components sincronizados. */
function findHeader(components: unknown): RawHeader | null {
  if (!Array.isArray(components)) return null;
  for (const comp of components) {
    if (!comp || typeof comp !== 'object') continue;
    const c = comp as { type?: unknown };
    if (String(c.type).toUpperCase() === 'HEADER') return comp as RawHeader;
  }
  return null;
}

function hasHeaderVar(v: HeaderVars): boolean {
  return Boolean(v.text || v.mediaLink || v.mediaId);
}

/** Component de header de mídia: {type:'header', parameters:[{type:'image', image:{...}}]}. */
function mediaHeaderComponent(
  kind: string,
  vars: HeaderVars,
  templateName: string,
): Record<string, unknown> {
  if (vars.mediaLink && vars.mediaId) {
    throw new TemplateParamsError(
      `Template "${templateName}": informe "headerMedia" (URL) OU "headerMediaId" ` +
        `(mídia já subida à Meta), nunca os dois — não dá para saber qual vale.`,
    );
  }
  // A Meta aceita `id` (mídia já subida) ou `link` (URL pública) — mesmo media
  // object usado em sendMedia.
  const media: Record<string, unknown> = vars.mediaId
    ? { id: vars.mediaId }
    : { link: vars.mediaLink };
  if (kind === 'document' && vars.filename) media.filename = vars.filename;
  return { type: 'header', parameters: [{ type: kind, [kind]: media }] };
}

/**
 * Monta o component de HEADER do payload de envio (0 ou 1 component).
 *
 * - Header estático (TEXT sem placeholder) ou template sem header → NENHUM
 *   component (mandar um sobrando também dá 132000).
 * - Header TEXT com {{1}} → exige a variável `header`.
 * - Header IMAGE/VIDEO/DOCUMENT → exige `headerMedia` (URL) ou `headerMediaId`,
 *   mesmo quando o template foi aprovado com mídia de exemplo.
 * - Faltando a variável → TemplateParamsError, antes de tocar na Graph API.
 * - Template não sincronizado: confia no informado (mesmo critério do botão e
 *   do idioma); aí `headerMediaType` é obrigatório para mídia, porque sem os
 *   components não há como saber se é image/video/document.
 */
export function buildHeaderComponent(
  components: unknown,
  headerVars: HeaderVars,
  templateName: string,
): Record<string, unknown>[] {
  const header = findHeader(components);

  if (!header) {
    if (!hasHeaderVar(headerVars)) return [];
    // Components sincronizados existem e não têm HEADER: variável sobrando.
    if (Array.isArray(components)) {
      throw new TemplateParamsError(
        `Template "${templateName}": foram informadas variáveis de header, mas o ` +
          `template não tem header.`,
      );
    }
    // Não sincronizado: confia no chamador.
    if (headerVars.text) {
      return [{ type: 'header', parameters: [{ type: 'text', text: headerVars.text }] }];
    }
    const kind = String(headerVars.mediaType ?? '').toLowerCase();
    if (!MEDIA_FORMATS.has(kind.toUpperCase())) {
      throw new TemplateParamsError(
        `Template "${templateName}" não sincronizado: informe "headerMediaType" ` +
          `(image, video ou document) para montar o header de mídia, ou rode o sync.`,
      );
    }
    return [mediaHeaderComponent(kind, headerVars, templateName)];
  }

  const format = String(header.format ?? 'TEXT').toUpperCase();

  if (MEDIA_FORMATS.has(format)) {
    if (headerVars.text) {
      throw new TemplateParamsError(
        `Template "${templateName}": o header é de mídia (${format}); use ` +
          `"headerMedia"/"headerMediaId", não "header".`,
      );
    }
    if (!headerVars.mediaLink && !headerVars.mediaId) {
      throw new TemplateParamsError(
        `Template "${templateName}": o header é de mídia (${format}) e exige ` +
          `"headerMedia" (URL pública) ou "headerMediaId", que não foi informado.`,
      );
    }
    return [mediaHeaderComponent(format.toLowerCase(), headerVars, templateName)];
  }

  // Header TEXT: só precisa de parâmetro se tiver placeholder.
  if (!PLACEHOLDER.test(String(header.text ?? ''))) {
    if (hasHeaderVar(headerVars)) {
      throw new TemplateParamsError(
        `Template "${templateName}": o header é estático e não aceita variável.`,
      );
    }
    return [];
  }
  if (headerVars.mediaLink || headerVars.mediaId) {
    throw new TemplateParamsError(
      `Template "${templateName}": o header é TEXT; use "header", não "headerMedia".`,
    );
  }
  if (!headerVars.text) {
    throw new TemplateParamsError(
      `Template "${templateName}": o header tem variável e exige a variável "header", ` +
        `que não foi informada.`,
    );
  }
  return [{ type: 'header', parameters: [{ type: 'text', text: headerVars.text }] }];
}

// ----------------------------------------------------------------------- BODY

/** Localiza o component BODY nos components sincronizados. */
function findBody(components: unknown): { text?: unknown } | null {
  if (!Array.isArray(components)) return null;
  for (const comp of components) {
    if (!comp || typeof comp !== 'object') continue;
    const c = comp as { type?: unknown };
    if (String(c.type).toUpperCase() === 'BODY') return comp as { text?: unknown };
  }
  return null;
}

/**
 * Números DISTINTOS dos placeholders de um texto, em ordem crescente.
 * "{{1}} fala com {{1}} sobre {{2}}" → ['1','2'] (a Meta conta parâmetros
 * distintos, não ocorrências).
 */
function placeholderNumbers(text: unknown): string[] {
  const found = String(text ?? '').match(/\{\{\s*(\d+)\s*\}\}/g) ?? [];
  const nums = new Set(found.map((p) => p.replace(/[^\d]/g, '')));
  return [...nums].sort((a, b) => Number(a) - Number(b));
}

/**
 * Monta o component de BODY do payload de envio, VALIDANDO a contagem antes de
 * gastar uma chamada na Graph API.
 *
 * O 132000 da Meta é erro de *divergência* de contagem — dispara tanto com
 * variável a menos quanto a mais (é o mesmo critério que este arquivo já aplica
 * a botão e header). Por isso os dois lados falham aqui, com a mensagem dizendo
 * exatamente qual placeholder está sobrando ou faltando, em vez do 132000 opaco.
 *
 * - Template não sincronizado (sem components): confia nas variáveis
 *   informadas, mesmo critério do botão, do header e do resolveTemplateLanguage.
 * - String VAZIA conta como informada. É deliberado: `resolveVarSource` devolve
 *   '' quando o contato não tem o dado de CRM, e campanhas em produção já
 *   dependem disso. Validar contagem não pode virar, de contrabando, uma
 *   validação de conteúdo que quebraria disparo que hoje funciona.
 */
export function buildBodyComponent(
  components: unknown,
  bodyVars: Record<string, string>,
  templateName: string,
): Record<string, unknown>[] {
  const informadas = Object.keys(bodyVars).sort((a, b) => Number(a) - Number(b));
  const body = findBody(components);

  // Sem estrutura sincronizada: não dá para validar — usa o que foi informado.
  if (!body) {
    if (Array.isArray(components) && informadas.length) {
      throw new TemplateParamsError(
        `Template "${templateName}": foram informadas ${informadas.length} variável(is) ` +
          `de corpo, mas o template não tem component BODY.`,
      );
    }
    if (!informadas.length) return [];
    return [
      {
        type: 'body',
        parameters: informadas.map((k) => ({ type: 'text', text: bodyVars[k] })),
      },
    ];
  }

  const esperadas = placeholderNumbers(body.text);
  const esperadasSet = new Set(esperadas);

  const faltando = esperadas.filter((n) => bodyVars[n] === undefined);
  if (faltando.length) {
    throw new TemplateParamsError(
      `Template "${templateName}": o corpo espera ${esperadas.length} variável(is) ` +
        `(${esperadas.map((n) => `{{${n}}}`).join(', ')}) e faltou ` +
        `${faltando.map((n) => `"${n}"`).join(', ')}.`,
    );
  }

  const sobrando = informadas.filter((n) => !esperadasSet.has(n));
  if (sobrando.length) {
    throw new TemplateParamsError(
      `Template "${templateName}": foi informada a variável ${sobrando
        .map((n) => `"${n}"`)
        .join(', ')}, mas o corpo do template ${
        esperadas.length
          ? `só tem ${esperadas.map((n) => `{{${n}}}`).join(', ')}`
          : 'não tem nenhuma variável'
      }.`,
    );
  }

  if (!esperadas.length) return [];
  // Ordem posicional: a Meta lê os parâmetros por POSIÇÃO, não por nome.
  return [
    {
      type: 'body',
      parameters: esperadas.map((n) => ({ type: 'text', text: bodyVars[n] })),
    },
  ];
}
