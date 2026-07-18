import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { api, loadToken, type Conversation, type Instance, type SessionUser } from './src/api';
import { registerForPushNotifications } from './src/push';
import { LoginScreen } from './src/screens/LoginScreen';
import { InstancesScreen } from './src/screens/InstancesScreen';
import { ConversationsScreen } from './src/screens/ConversationsScreen';
import { ThreadScreen } from './src/screens/ThreadScreen';

/**
 * WA Manager Mobile (V2 / P5.3) — cliente FINO para atendentes: login,
 * escolher instância, ler e responder conversas. Nada de campanhas/fluxos/CRM.
 * Toda regra de negócio (e o papel 'agent') vive no backend — o app só
 * consome a mesma REST API do painel.
 */

type Route =
  | { name: 'login' }
  | { name: 'instances' }
  | { name: 'conversations'; instance: Instance }
  | { name: 'thread'; instance: Instance; conversation: Conversation };

export default function App() {
  const [route, setRoute] = useState<Route | null>(null); // null = carregando

  useEffect(() => {
    // Sessão persistida: com token salvo, pula o login (o backend valida).
    loadToken().then((token) => {
      setRoute(token ? { name: 'instances' } : { name: 'login' });
    });
    void registerForPushNotifications(); // gancho (desligado por padrão)
  }, []);

  async function logout() {
    await api.logout();
    setRoute({ name: 'login' });
  }

  if (!route) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#25d366" />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      {route.name === 'login' && (
        <LoginScreen onLogin={(_user: SessionUser) => setRoute({ name: 'instances' })} />
      )}
      {route.name === 'instances' && (
        <InstancesScreen
          onSelect={(instance) => setRoute({ name: 'conversations', instance })}
          onLogout={logout}
        />
      )}
      {route.name === 'conversations' && (
        <ConversationsScreen
          instance={route.instance}
          onOpen={(conversation) =>
            setRoute({ name: 'thread', instance: route.instance, conversation })
          }
          onBack={() => setRoute({ name: 'instances' })}
        />
      )}
      {route.name === 'thread' && (
        <ThreadScreen
          instance={route.instance}
          conversation={route.conversation}
          onBack={() => setRoute({ name: 'conversations', instance: route.instance })}
        />
      )}
    </>
  );
}
