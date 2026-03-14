const SESSION_KEY = 'github-personal-assistant.session-token';

const canUseStorage = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

export const tokenStorage = {
  async get() {
    return canUseStorage() ? window.localStorage.getItem(SESSION_KEY) : null;
  },
  async set(value: string) {
    if (canUseStorage()) {
      window.localStorage.setItem(SESSION_KEY, value);
    }
  },
  async clear() {
    if (canUseStorage()) {
      window.localStorage.removeItem(SESSION_KEY);
    }
  },
};
