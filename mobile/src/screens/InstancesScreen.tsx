import React, { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api, type Instance } from '../api';
import { theme } from '../theme';

export function InstancesScreen({
  onSelect,
  onLogout,
}: {
  onSelect: (instance: Instance) => void;
  onLogout: () => void;
}) {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listInstances()
      .then(setInstances)
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <View style={s.wrap}>
      <View style={s.topbar}>
        <Text style={s.title}>Instâncias</Text>
        <TouchableOpacity onPress={onLogout}>
          <Text style={s.logout}>Sair</Text>
        </TouchableOpacity>
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <FlatList
        data={instances}
        keyExtractor={(i) => i.id}
        ListEmptyComponent={<Text style={s.empty}>Nenhuma instância na sua organização.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={s.card} onPress={() => onSelect(item)}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{item.name}</Text>
              <Text style={s.meta}>
                {item.provider_type === 'baileys' ? 'Baileys' : 'API Oficial'} ·{' '}
                {item.connection_status}
              </Text>
            </View>
            <View
              style={[
                s.dot,
                { backgroundColor: item.connection_status === 'connected' ? theme.green : '#cbd5e1' },
              ]}
            />
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
  title: { fontSize: 20, fontWeight: '700', color: theme.text },
  logout: { color: theme.muted },
  error: { color: theme.danger, paddingHorizontal: 16, marginBottom: 8 },
  empty: { color: theme.muted, textAlign: 'center', marginTop: 40 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.card,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
  },
  name: { fontWeight: '600', fontSize: 15, color: theme.text },
  meta: { color: theme.muted, fontSize: 12, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
