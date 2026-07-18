# WA Manager Mobile (V2 / P5.3)

App **enxuto para atendentes**: login, escolher instância, ler e responder
conversas. É um **cliente fino** sobre a MESMA REST API da V2 — zero lógica de
negócio aqui. O papel `agent` é aplicado pelo backend (403 fora do Live Chat).

## Rodar em desenvolvimento

```bash
cd mobile
npm install
# Aponte a API: edite app.json → expo.extra.apiUrl
#   (em dev, o IP da máquina que roda `npm run dev`, ex.: http://192.168.0.10:3000)
npx expo start          # escaneie o QR com o app Expo Go (Android/iOS)
```

## Login

Use um usuário criado no painel (V2): o owner registra em `POST /api/auth/register`
e cria atendentes em `POST /api/users` (role `agent`). O token JWT fica salvo no
dispositivo (AsyncStorage) — sessão persiste entre aberturas.

## Build do APK (EAS)

```bash
npm install -g eas-cli
eas login                      # conta Expo
cd mobile
eas build -p android --profile preview   # gera APK instalável
# perfil "production" gera .aab para a Play Store
```

O `eas.json` já define os perfis. Ajuste `android.package` no `app.json` se
quiser outro identificador.

## Notificações push (gancho)

`src/push.ts` tem o gancho pronto (desligado). Para ativar:
1. `npx expo install expo-notifications`
2. Descomente o corpo de `registerForPushNotifications()`
3. Crie no backend uma rota para salvar o Expo Push Token do usuário e dispare
   push (Expo Push API) quando chegar mensagem nova.

## Limitações conhecidas

- Envio de mídia: por URL (`api.sendImageUrl`) — upload de arquivo do aparelho
  fica para evolução futura (exige endpoint de upload no backend).
- Atualização por polling curto (4–5s), como no painel web.
