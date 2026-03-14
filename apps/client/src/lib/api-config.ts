import Constants from 'expo-constants';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const API_URL_KEY = 'github-personal-assistant.api-url';

export const getDefaultApiUrl = () =>
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.hostUri ? `http://${Constants.expoConfig.hostUri.split(':')[0]}:4000` : 'http://localhost:4000');

export const getApiUrlOverride = async () => {
  if (Platform.OS === 'web') {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(API_URL_KEY);
  }

  return SecureStore.getItemAsync(API_URL_KEY);
};

export const setApiUrlOverride = async (value: string) => {
  if (Platform.OS === 'web') {
    window.localStorage.setItem(API_URL_KEY, value);
    return;
  }

  await SecureStore.setItemAsync(API_URL_KEY, value);
};

export const clearApiUrlOverride = async () => {
  if (Platform.OS === 'web') {
    window.localStorage.removeItem(API_URL_KEY);
    return;
  }

  await SecureStore.deleteItemAsync(API_URL_KEY);
};

export const resolveApiUrl = async () => (await getApiUrlOverride()) || getDefaultApiUrl();
