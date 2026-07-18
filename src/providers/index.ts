import type { Instance } from '../repo/types';
import { MetaCloudProvider } from './MetaCloudProvider';
import { BaileysProvider, type BaileysSender } from './BaileysProvider';
import type { Provider } from './types';

export * from './types';
export { MetaCloudProvider } from './MetaCloudProvider';
export {
  BaileysProvider,
  makeOutboxSender,
  type BaileysSender,
  type BaileysSendPayload,
} from './BaileysProvider';
export { MetaApiError, UnsupportedByProviderError } from './errors';

// Meta é stateless quanto à instância; uma instância do provider basta.
const meta = new MetaCloudProvider();

export interface GetProviderOpts {
  /** Transporte do Baileys (outbox na web; socket no worker). */
  baileysSender?: BaileysSender;
}

/**
 * Dispatcher: escolhe a implementação de Provider pelo provider_type da
 * instância. O motor de fluxos, campanhas e Live Chat nunca sabem qual
 * provider está em uso — só chamam getProvider(instance).sendX(...).
 */
export function getProvider(
  instance: Pick<Instance, 'provider_type'>,
  opts: GetProviderOpts = {},
): Provider {
  switch (instance.provider_type) {
    case 'baileys': {
      if (!opts.baileysSender) {
        throw new Error(
          'BaileysProvider requer um transporte (outbox na web, socket no worker)',
        );
      }
      return new BaileysProvider(opts.baileysSender);
    }
    case 'meta':
      return meta;
    default: {
      const exhaustive: never = instance.provider_type;
      throw new Error(`provider_type desconhecido: ${String(exhaustive)}`);
    }
  }
}
