const API_URL_KEY = 'github-personal-assistant.api-url';

const canUseStorage = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

export const getDefaultApiUrl = () => {
  if (typeof window !== 'undefined') {
    const { hostname, protocol } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://127.0.0.1:4000';
    }

    if (hostname.endsWith('.ts.net') && protocol === 'https:') {
      return `${protocol}//${hostname}`;
    }
  }

  return 'http://127.0.0.1:4000';
};

export const getApiUrlOverride = async () => (canUseStorage() ? window.localStorage.getItem(API_URL_KEY) : null);
export const setApiUrlOverride = async (value: string) => {
  if (canUseStorage()) {
    window.localStorage.setItem(API_URL_KEY, value);
  }
};
export const clearApiUrlOverride = async () => {
  if (canUseStorage()) {
    window.localStorage.removeItem(API_URL_KEY);
  }
};
export const resolveApiUrl = async () => (await getApiUrlOverride()) || getDefaultApiUrl();
