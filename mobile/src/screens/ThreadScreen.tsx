import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { api, messageText, type Conversation, type Instance, type Message } from '../api';
import { theme } from '../theme';

const POLL_MS = 4000;

export function ThreadScreen({
  instance,
  conversation,
  onBack,
}: {
  instance: Instance;
  conversation: Conversation;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    api
      .listMessages(instance.id, conversation.phone)
      // API retorna DESC (mais novas primeiro); com FlatList `inverted`,
      // o item [0] renderiza embaixo — exatamente o que queremos.
      .then((data) => setMessages(data))
      .catch((e) => setError((e as Error).message));
  }, [instance.id, conversation.phone]);

  useEffect(() => {
    api.markRead(instance.id, conversation.phone).catch(() => undefined);
    load();
    timer.current = setInterval(load, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [instance.id, conversation.phone, load]);

  async function send() {
    const body = text.trim();
    if (!body) return;
    setText('');
    try {
      await api.sendText(instance.id, conversation.phone, body);
      load();
    } catch (e) {
      setError('Falha ao enviar: ' + (e as Error).message);
    }
  }

  return (
    <KeyboardAvoidingView
      style={s.wrap}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={s.topbar}>
        <TouchableOpacity onPress={onBack}>
          <Text style={s.back}>‹ Conversas</Text>
        </TouchableOpacity>
        <Text style={s.title}>{conversation.name ?? conversation.phone}</Text>
        <View style={{ width: 80 }} />
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}

      {/* inverted: mensagens mais novas embaixo, composer sempre visível —
          o equivalente mobile da regra do grid-template-rows do painel web. */}
      <FlatList
        style={s.list}
        data={messages}
        inverted
        keyExtractor={(msg) => msg.id}
        renderItem={({ item }) => (
          <View style={[s.bubble, item.direction === 'out' ? s.bubbleOut : s.bubbleIn]}>
            <Text style={s.bubbleText}>{messageText(item.type, item.content)}</Text>
            <Text style={s.time}>
              {new Date(item.created_at).toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
              })}
              {item.direction === 'out' ? ' · ' + item.status : ''}
            </Text>
          </View>
        )}
      />

      <View style={s.composer}>
        <TextInput
          style={s.input}
          placeholder="Digite uma mensagem…"
          value={text}
          onChangeText={setText}
          multiline
        />
        <TouchableOpacity style={s.send} onPress={send}>
          <Text style={s.sendText}>➤</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg, paddingTop: 48 },
  topbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  back: { color: theme.greenDark, width: 90 },
  title: { fontWeight: '700', fontSize: 15, color: theme.text },
  error: { color: theme.danger, paddingHorizontal: 16, marginBottom: 6 },
  list: { flex: 1, paddingHorizontal: 12 },
  bubble: {
    maxWidth: '78%',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginVertical: 3,
  },
  bubbleIn: {
    alignSelf: 'flex-start',
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
  },
  bubbleOut: { alignSelf: 'flex-end', backgroundColor: theme.bubbleOut },
  bubbleText: { fontSize: 14, color: theme.text },
  time: { fontSize: 10, color: theme.muted, marginTop: 3, textAlign: 'right' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    backgroundColor: theme.card,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    maxHeight: 110,
    fontSize: 15,
    backgroundColor: theme.bg,
  },
  send: {
    marginLeft: 8,
    backgroundColor: theme.green,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { color: '#04220f', fontSize: 18, fontWeight: '700' },
});
