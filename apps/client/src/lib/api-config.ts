const API_URL_KEY = 'github-personal-assistant.api-url';
export const API_URL_CHANGE_EVENT = 'github-personal-assistant:api-url-change';

declare global {
  interface Window {
    __GPA_DEFAULT_API_URL__?: string;
  }
}

const canUseStorage = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const notifyApiUrlChanged = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(API_URL_CHANGE_EVENT));
  }
};

export const getDefaultApiUrl = () => {
  if (typeof window !== 'undefined') {
    const configuredDefault = window.__GPA_DEFAULT_API_URL__?.trim();
    if (configuredDefault) {
      return configuredDefault.replace(/\/+$/, '');
    }

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
    notifyApiUrlChanged();
  }
};
export const clearApiUrlOverride = async () => {
  if (canUseStorage()) {
    window.localStorage.removeItem(API_URL_KEY);
    notifyApiUrlChanged();
  }
};
export const resolveApiUrl = async () => (await getApiUrlOverride()) || getDefaultApiUrl();
