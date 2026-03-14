import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { AuthCapabilities, GitHubDeviceAuthStart, UserSession } from '@github-personal-assistant/shared';

import {
  bootstrapLocalSession,
  getAuthCapabilities,
  getGitHubAuthorizeUrl,
  getSession,
  logout,
  pollGitHubDeviceAuth,
  registerUnauthorizedHandler,
  startGitHubDeviceAuth,
} from '../lib/api.js';
import { API_URL_CHANGE_EVENT, resolveApiUrl } from '../lib/api-config.js';
import { tokenStorage } from '../lib/token-storage.js';

type SignOutOptions = {
  manual?: boolean;
};

type AuthContextValue = {
  isRestoring: boolean;
  session: UserSession | null;
  authCapabilities: AuthCapabilities | null;
  pendingDeviceAuth: GitHubDeviceAuthStart | null;
  signIn: () => Promise<void>;
  openPendingGitHubVerification: () => Promise<void>;
  signOut: (options?: SignOutOptions) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getRedirectSessionToken = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  const url = new URL(window.location.href);
  const sessionToken = url.searchParams.get('sessionToken');
  if (!sessionToken) {
    return null;
  }

  url.searchParams.delete('sessionToken');
  url.searchParams.delete('login');
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  return sessionToken;
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isRestoring, setIsRestoring] = useState(true);
  const [session, setSession] = useState<UserSession | null>(null);
  const [authCapabilities, setAuthCapabilities] = useState<AuthCapabilities | null>(null);
  const [pendingDeviceAuth, setPendingDeviceAuth] = useState<GitHubDeviceAuthStart | null>(null);
  const manualLocalSignOutRef = useRef(false);
  const activeApiUrlRef = useRef<string | null>(null);
  const authCapabilitiesRef = useRef<AuthCapabilities | null>(null);

  useEffect(() => {
    authCapabilitiesRef.current = authCapabilities;
  }, [authCapabilities]);

  const clearCachedSession = useCallback(async (apiUrl: string, capabilities: AuthCapabilities) => {
    await tokenStorage.clear(apiUrl, capabilities.mode, capabilities.version);
  }, []);

  const clearLocalSessionState = useCallback(() => {
    setPendingDeviceAuth(null);
    setSession(null);
  }, []);

  const restore = useCallback(
    async (options?: { allowLocalBootstrap?: boolean }) => {
      const allowLocalBootstrap = options?.allowLocalBootstrap ?? true;
      setIsRestoring(true);

      try {
        const [apiUrl, capabilities] = await Promise.all([resolveApiUrl(), getAuthCapabilities()]);
        activeApiUrlRef.current = apiUrl;
        setAuthCapabilities(capabilities);

        let sessionToken = getRedirectSessionToken();
        if (sessionToken) {
          await tokenStorage.set(apiUrl, capabilities.mode, capabilities.version, sessionToken);
        } else {
          sessionToken = await tokenStorage.get(apiUrl, capabilities.mode, capabilities.version);
        }

        if (sessionToken) {
          try {
            const payload = await getSession(sessionToken);
            if (payload.session) {
              setSession(payload.session);
              setPendingDeviceAuth(null);
              return;
            }
            await clearCachedSession(apiUrl, capabilities);
          } catch (error) {
            if (!(error instanceof Error) || !/unavailable right now/i.test(error.message)) {
              await clearCachedSession(apiUrl, capabilities);
            }
          }
        }

        clearLocalSessionState();

        if (capabilities.mode === 'local' && allowLocalBootstrap && !manualLocalSignOutRef.current) {
          const payload = await bootstrapLocalSession();
          await tokenStorage.set(apiUrl, capabilities.mode, capabilities.version, payload.session.sessionToken);
          setSession(payload.session);
        }
      } finally {
        setIsRestoring(false);
      }
    },
    [clearCachedSession, clearLocalSessionState],
  );

  useEffect(() => {
    void restore();
  }, [restore]);

  useEffect(() => {
    const handleApiUrlChange = () => {
      manualLocalSignOutRef.current = false;
      void restore();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener(API_URL_CHANGE_EVENT, handleApiUrlChange);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener(API_URL_CHANGE_EVENT, handleApiUrlChange);
      }
    };
  }, [restore]);

  const handleUnauthorized = useCallback(async () => {
    const apiUrl = activeApiUrlRef.current;
    const capabilities = authCapabilitiesRef.current;
    if (apiUrl && capabilities) {
      await clearCachedSession(apiUrl, capabilities);
    }
    clearLocalSessionState();

    if (capabilities?.mode === 'local' && !manualLocalSignOutRef.current) {
      await restore();
    }
  }, [clearCachedSession, clearLocalSessionState, restore]);

  useEffect(() => {
    registerUnauthorizedHandler(() => handleUnauthorized());
    return () => registerUnauthorizedHandler(null);
  }, [handleUnauthorized]);

  const openDeviceVerification = useCallback(async (deviceAuth: GitHubDeviceAuthStart) => {
    const targetUrl = deviceAuth.verificationUriComplete ?? deviceAuth.verificationUri;
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  }, []);

  const signIn = useCallback(async () => {
    const capabilities = authCapabilitiesRef.current ?? (await getAuthCapabilities());
    const apiUrl = activeApiUrlRef.current ?? (await resolveApiUrl());
    activeApiUrlRef.current = apiUrl;
    setAuthCapabilities(capabilities);
    manualLocalSignOutRef.current = false;

    if (capabilities.mode === 'local') {
      const payload = await bootstrapLocalSession();
      await tokenStorage.set(apiUrl, capabilities.mode, capabilities.version, payload.session.sessionToken);
      setPendingDeviceAuth(null);
      setSession(payload.session);
      return;
    }

    if (capabilities.mode === 'github-oauth') {
      const redirectUri = window.location.href;
      const payload = await getGitHubAuthorizeUrl(redirectUri);
      window.location.assign(payload.authorizeUrl);
      return;
    }

    if (pendingDeviceAuth) {
      await openDeviceVerification(pendingDeviceAuth);
      return;
    }

    const deviceAuth = await startGitHubDeviceAuth();
    setPendingDeviceAuth(deviceAuth);
    await openDeviceVerification(deviceAuth);

    let currentInterval = deviceAuth.interval;
    while (true) {
      await sleep(currentInterval * 1000);
      const status = await pollGitHubDeviceAuth(deviceAuth.flowId);

      if (status.status === 'pending') {
        currentInterval = status.interval;
        setPendingDeviceAuth({
          flowId: status.flowId,
          userCode: status.userCode,
          verificationUri: status.verificationUri,
          verificationUriComplete: status.verificationUriComplete,
          expiresAt: status.expiresAt,
          interval: status.interval,
        });
        continue;
      }

      if (status.status === 'complete') {
        await tokenStorage.set(apiUrl, capabilities.mode, capabilities.version, status.session.sessionToken);
        setSession(status.session);
        setPendingDeviceAuth(null);
        return;
      }

      setPendingDeviceAuth(null);
      throw new Error(status.error);
    }
  }, [openDeviceVerification, pendingDeviceAuth]);

  const openPendingGitHubVerification = useCallback(async () => {
    if (!pendingDeviceAuth) {
      throw new Error('No GitHub device sign-in is currently pending.');
    }

    await openDeviceVerification(pendingDeviceAuth);
  }, [openDeviceVerification, pendingDeviceAuth]);

  const signOut = useCallback(
    async (options?: SignOutOptions) => {
      const capabilities = authCapabilitiesRef.current;
      const apiUrl = activeApiUrlRef.current;
      const manual = options?.manual ?? false;

      if (manual && capabilities?.mode === 'local') {
        manualLocalSignOutRef.current = true;
      }

      if (session) {
        try {
          await logout(session.sessionToken);
        } catch {
          // The local cache should still be cleared if the daemon already dropped this session.
        }
      }

      if (apiUrl && capabilities) {
        await clearCachedSession(apiUrl, capabilities);
      }

      clearLocalSessionState();

      if (!manual && capabilities?.mode === 'local') {
        await restore();
      }
    },
    [clearCachedSession, clearLocalSessionState, restore, session],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ isRestoring, session, authCapabilities, pendingDeviceAuth, signIn, openPendingGitHubVerification, signOut }),
    [authCapabilities, isRestoring, openPendingGitHubVerification, pendingDeviceAuth, session, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider.');
  }
  return context;
};
