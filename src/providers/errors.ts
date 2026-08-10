/**
 * Erro estruturado de uma chamada à Graph API da Meta. Carrega o `code` e a
 * `message` retornados pela Meta para que o chamador (serviço de mensageria)
 * possa gravá-los em messages.error_code / error_message — nunca descartar.
 */
export class MetaApiError extends Error {
  constructor(
    readonly code: string | null,
    message: string,
    readonly httpStatus: number,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

/**
 * Variáveis do template incompatíveis com a estrutura cadastrada na Meta (ex.:
 * botão de URL dinâmica sem a variável correspondente). Erro do CHAMADOR, pego
 * antes de tocar na Graph API — evita o 132000 opaco e o payload malformado.
 */
export class TemplateParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateParamsError';
  }
}

/** Recurso pedido não é suportado pelo provider da instância (ex.: template no Baileys). */
export class UnsupportedByProviderError extends Error {
  constructor(
    readonly capability: string,
    readonly providerType: string,
  ) {
    super(`Recurso "${capability}" não é suportado pelo provider "${providerType}"`);
    this.name = 'UnsupportedByProviderError';
  }
}
