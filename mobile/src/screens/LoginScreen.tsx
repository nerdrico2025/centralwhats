import React, { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { api, type SessionUser } from '../api';
import { theme } from '../theme';

export function LoginScreen({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email.trim(), password);
      onLogin(res.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.wrap}>
      <View style={s.logo}>
        <Text style={s.logoText}>WA</Text>
      </View>
      <Text style={s.title}>WA Manager</Text>
      <Text style={s.subtitle}>Atendimento</Text>

      <TextInput
        style={s.input}
        placeholder="E-mail"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={s.input}
        placeholder="Senha"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error ? <Text style={s.error}>{error}</Text> : null}
      <TouchableOpacity style={s.button} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color="#04220f" /> : <Text style={s.buttonText}>Entrar</Text>}
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', padding: 28, backgroundColor: theme.bg },
  logo: {
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: theme.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { fontWeight: '800', fontSize: 22, color: '#04220f' },
  title: { textAlign: 'center', fontSize: 24, fontWeight: '700', marginTop: 12, color: theme.text },
  subtitle: { textAlign: 'center', color: theme.muted, marginBottom: 28 },
  input: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    fontSize: 15,
  },
  error: { color: theme.danger, marginBottom: 12, textAlign: 'center' },
  button: {
    backgroundColor: theme.green,
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
  },
  buttonText: { fontWeight: '700', color: '#04220f', fontSize: 15 },
});
