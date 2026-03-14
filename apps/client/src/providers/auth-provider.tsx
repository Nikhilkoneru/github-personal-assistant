import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { GitHubDeviceAuthStart, UserSession } from '@github-personal-assistant/shared';

import { getSession, logout, pollGitHubDeviceAuth, registerUnauthorizedHandler, startGitHubDeviceAuth } from '../lib/api';
import { tokenStorage } from '../lib/token-storage';

type AuthContextValue = {
  isRestoring: boolean;
  session: UserSession | null;
  pendingDeviceAuth: GitHubDeviceAuthStart | null;
  signInWithGitHub: () => Promise<void>;
  openPendingGitHubVerification: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isRestoring, setIsRestoring] = useState(true);
  const [session, setSession] = useState<UserSession | null>(null);
  const [pendingDeviceAuth, setPendingDeviceAuth] = useState<GitHubDeviceAuthStart | null>(null);

  const clearLocalSession = useCallback(async () => {
    await tokenStorage.clear();
    setPendingDeviceAuth(null);
    setSession(null);
  }, []);

  useEffect(() => {
    registerUnauthorizedHandler(() => clearLocalSession());
    return () => registerUnauthorizedHandler(null);
  }, [clearLocalSession]);

  useEffect(() => {
    let isMounted = true;

    const restore = async () => {
      try {
        const token = await tokenStorage.get();
        if (!token) {
          return;
        }

        try {
          const payload = await getSession(token);
          if (!isMounted) {
            return;
          }
          if (payload.session) {
            setSession(payload.session);
          } else {
            await clearLocalSession();
          }
        } catch (error) {
          if (!isMounted) {
            return;
          }
          if (error instanceof Error && /unavailable right now/i.test(error.message)) {
            return;
          }
          await clearLocalSession();
        }
      } finally {
        if (isMounted) {
          setIsRestoring(false);
        }
      }
    };

    void restore();
    return () => {
      isMounted = false;
    };
  }, [clearLocalSession]);

  const openDeviceVerification = useCallback(async (deviceAuth: GitHubDeviceAuthStart) => {
    const targetUrl = deviceAuth.verificationUriComplete ?? deviceAuth.verificationUri;
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  }, []);

  const signInWithGitHub = useCallback(async () => {
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
        await tokenStorage.set(status.session.sessionToken);
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

  const signOut = useCallback(async () => {
    if (session) {
      try {
        await logout(session.sessionToken);
      } catch {
        // Clear the local session even if the backend already dropped it.
      }
    }
    await clearLocalSession();
  }, [clearLocalSession, session]);

  const value = useMemo<AuthContextValue>(
    () => ({ isRestoring, session, pendingDeviceAuth, signInWithGitHub, openPendingGitHubVerification, signOut }),
    [isRestoring, openPendingGitHubVerification, pendingDeviceAuth, session, signInWithGitHub, signOut],
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
