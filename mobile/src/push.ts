/**
 * GANCHO de notificações push (opcional no P5.3).
 *
 * Para ativar:
 *   1. npx expo install expo-notifications
 *   2. Descomente o corpo abaixo e registre o Expo Push Token no backend
 *      (ex.: POST /api/users/me/push-token — rota a criar) para o servidor
 *      disparar push em mensagem nova via Expo Push API.
 */
export async function registerForPushNotifications(): Promise<string | null> {
  // const Notifications = await import('expo-notifications');
  // const { status } = await Notifications.requestPermissionsAsync();
  // if (status !== 'granted') return null;
  // const token = (await Notifications.getExpoPushTokenAsync()).data;
  // return token;
  return null; // gancho pronto; desligado por padrão
}
