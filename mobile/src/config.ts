import Constants from 'expo-constants';

/**
 * URL da API (a MESMA REST da V2 — o app é um cliente fino, sem lógica de
 * negócio própria). Configure em app.json → expo.extra.apiUrl.
 * Em dev, aponte para a máquina que roda `npm run dev` (ex.: http://192.168.0.10:3000).
 */
export const API_URL: string =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://localhost:3000';
