const SESSION_PREFIX = 'github-personal-assistant.session-token';

const canUseStorage = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const toOriginKey = (apiUrl: string) => {
  try {
    return new URL(apiUrl).origin;
  } catch {
    return apiUrl;
  }
};

const buildSessionKey = (apiUrl: string, authMode: string, authVersion: string) =>
  `${SESSION_PREFIX}:${toOriginKey(apiUrl)}:${authMode}:${authVersion}`;

export const tokenStorage = {
  async get(apiUrl: string, authMode: string, authVersion: string) {
    return canUseStorage() ? window.localStorage.getItem(buildSessionKey(apiUrl, authMode, authVersion)) : null;
  },
  async set(apiUrl: string, authMode: string, authVersion: string, value: string) {
    if (canUseStorage()) {
      window.localStorage.setItem(buildSessionKey(apiUrl, authMode, authVersion), value);
    }
  },
  async clear(apiUrl: string, authMode: string, authVersion: string) {
    if (canUseStorage()) {
      window.localStorage.removeItem(buildSessionKey(apiUrl, authMode, authVersion));
    }
  },
};
