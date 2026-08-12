import type { Instance } from '../repo/types';
import { MetaApiError } from './errors';

type FetchImpl = typeof fetch;

export interface MetaTemplatesOptions {
  fetchImpl?: FetchImpl;
  baseUrl?: string;
  apiVersion?: string;
  /** Máximo de páginas a seguir (proteção contra loop). */
  maxPages?: number;
}

/** Template cru como a Graph API retorna (nível WABA). */
export interface RawMetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: unknown;
}

/**
 * Busca os templates da WABA (GET /{waba_id}/message_templates), seguindo a
 * paginação. Encapsula o HTTP da Graph API — o domínio nunca fala com a Meta
 * diretamente. (Sync de templates não é "envio", então fica fora de provider.*,
 * mas mora aqui na camada de providers junto do resto do acesso à Graph API.)
 */
export async function fetchMetaTemplates(
  instance: Instance,
  opts: MetaTemplatesOptions = {},
): Promise<RawMetaTemplate[]> {
  if (!instance.waba_id) {
    throw new MetaApiError(null, 'Instância sem waba_id configurado', 400);
  }
  if (instance.secrets_unreadable) {
    throw new MetaApiError(
      null,
      'As credenciais desta instância não puderam ser decifradas com a SECRETS_ENCRYPTION_KEY ' +
        'atual. Restaure a chave usada para gravá-las ou recadastre o token da Meta.',
      400,
    );
  }
  if (!instance.token) {
    throw new MetaApiError(null, 'Instância sem token configurado', 400);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? process.env.GRAPH_API_BASE ?? 'https://graph.facebook.com')
    .replace(/\/+$/, '');
  const apiVersion = opts.apiVersion ?? process.env.GRAPH_API_VERSION ?? 'v21.0';
  const maxPages = opts.maxPages ?? 50;

  const fields = 'id,name,status,category,language,components';
  let url: string | null =
    `${baseUrl}/${apiVersion}/${instance.waba_id}/message_templates?limit=200&fields=${fields}`;

  const out: RawMetaTemplate[] = [];
  for (let page = 0; url && page < maxPages; page++) {
    const resp = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${instance.token}` },
    });
    const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!resp.ok) {
      const err = (json.error as Record<string, unknown>) ?? {};
      throw new MetaApiError(
        err.code != null ? String(err.code) : null,
        (err.message as string) ?? `Graph API respondeu ${resp.status}`,
        resp.status,
        json,
      );
    }
    for (const t of (json.data as RawMetaTemplate[]) ?? []) out.push(t);
    const paging = json.paging as { next?: string } | undefined;
    url = paging?.next ?? null;
  }
  return out;
}
