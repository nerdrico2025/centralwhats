import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from './config';

/**
 * Client da MESMA REST API da V2 (cliente fino — zero lógica de negócio).
 * Papel 'agent' é respeitado pelo BACKEND (403 fora do Live Chat); o app só
 * consome o que a API permite.
 */

const TOKEN_KEY = 'wa.token';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  /**
   * Papel NA CONTA ATIVA da sessão (P6.1): o mesmo usuário pode ser owner numa
   * conta e agent em outra. Não existe mais "a org do usuário" — a conta ativa
   * vem em `active_org_id` na resposta do login.
   */
  role: 'owner' | 'agent';
  status: 'active' | 'disabled';
}

export interface Instance {
  id: string;
  name: string;
  provider_type: string;
  connection_status: string;
  active: boolean;
}

export interface Conversation {
  phone: string;
  name: string | null;
  unread: number;
  last_message_at: string;
  last_message_direction: 'in' | 'out';
  last_message_type: string;
  last_message_content: unknown;
}

export interface Message {
  id: string;
  direction: 'in' | 'out';
  type: string;
  content: unknown;
  status: string;
  created_at: string;
}

let token: string | null = null;

export async function loadToken(): Promise<string | null> {
  token = await AsyncStorage.getItem(TOKEN_KEY);
  return token;
}

export async function setToken(value: string | null): Promise<void> {
  token = value;
  if (value) await AsyncStorage.setItem(TOKEN_KEY, value);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

async function raw<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) detail = json.error;
    } catch {
      /* corpo não-JSON */
    }
    throw new Error(detail);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

export const api = {
  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; user: SessionUser; active_org_id: string }> {
    const res = await raw<{ token: string; user: SessionUser; active_org_id: string }>('POST', '/api/auth/login', {
      email,
      password,
    });
    await setToken(res.token);
    return res;
  },

  async logout(): Promise<void> {
    await setToken(null);
  },

  listInstances(): Promise<Instance[]> {
    return raw('GET', '/api/instances');
  },

  listConversations(instanceId: string): Promise<Conversation[]> {
    return raw('GET', `/api/instances/${instanceId}/conversations`);
  },

  listMessages(instanceId: string, phone: string): Promise<Message[]> {
    return raw(
      'GET',
      `/api/instances/${instanceId}/conversations/${encodeURIComponent(phone)}/messages?limit=100`,
    );
  },

  markRead(instanceId: string, phone: string): Promise<void> {
    return raw(
      'POST',
      `/api/instances/${instanceId}/conversations/${encodeURIComponent(phone)}/read`,
    );
  },

  sendText(instanceId: string, to: string, text: string): Promise<unknown> {
    return raw('POST', `/api/instances/${instanceId}/messages`, { type: 'text', to, text });
  },

  /** Mídia básica por URL (upload de arquivo fica para evolução futura). */
  sendImageUrl(instanceId: string, to: string, url: string, caption?: string): Promise<unknown> {
    return raw('POST', `/api/instances/${instanceId}/messages`, {
      type: 'media',
      to,
      media: { kind: 'image', url, caption },
    });
  },
};

/** Texto exibível de uma mensagem (espelha o helper do painel web). */
export function messageText(type: string, content: unknown): string {
  const c = (content ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'text':
      return String(c.body ?? c.text ?? '');
    case 'image':
      return '🖼️ [imagem]';
    case 'video':
      return '🎬 [vídeo]';
    case 'audio':
      return '🔊 [áudio]';
    case 'document':
      return '📎 ' + String(c.filename ?? '[documento]');
    case 'interactive':
      return String(c.title ?? '[interativo]');
    case 'template':
      return '[template]';
    default:
      return `[${type}]`;
  }
}
