import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api, messageText, type Conversation, type Instance } from '../api';
import { theme } from '../theme';

const POLL_MS = 5000; // polling curto — mesmo padrão do painel web

export function ConversationsScreen({
  instance,
  onOpen,
  onBack,
}: {
  instance: Instance;
  onOpen: (conversation: Conversation) => void;
  onBack: () => void;
}) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    api
      .listConversations(instance.id)
      .then((data) => {
        setConvs(data);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [instance.id]);

  useEffect(() => {
    load();
    timer.current = setInterval(load, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  return (
    <View style={s.wrap}>
      <View style={s.topbar}>
        <TouchableOpacity onPress={onBack}>
          <Text style={s.back}>‹ Instâncias</Text>
        </TouchableOpacity>
        <Text style={s.title}>{instance.name}</Text>
        <View style={{ width: 70 }} />
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <FlatList
        data={convs}
        keyExtractor={(c) => c.phone}
        ListEmptyComponent={<Text style={s.empty}>Sem conversas ainda.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={s.item} onPress={() => onOpen(item)}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{item.name ?? item.phone}</Text>
              <Text style={s.preview} numberOfLines={1}>
                {(item.last_message_direction === 'out' ? 'Você: ' : '') +
                  messageText(item.last_message_type, item.last_message_content)}
              </Text>
            </View>
            {item.unread > 0 ? (
              <View style={s.badge}>
                <Text style={s.badgeText}>{item.unread}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg, paddingTop: 48 },
  topbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  back: { color: theme.greenDark, width: 90 },
  title: { fontWeight: '700', fontSize: 16, color: theme.text },
  error: { color: theme.danger, paddingHorizontal: 16, marginBottom: 8 },
  empty: { color: theme.muted, textAlign: 'center', marginTop: 40 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.card,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  name: { fontWeight: '600', fontSize: 15, color: theme.text },
  preview: { color: theme.muted, fontSize: 13, marginTop: 2 },
  badge: {
    backgroundColor: theme.green,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginLeft: 8,
  },
  badgeText: { fontWeight: '700', fontSize: 12, color: '#04220f' },
});
