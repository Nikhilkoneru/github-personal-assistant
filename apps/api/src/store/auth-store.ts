import crypto from 'node:crypto';

import type {
  AppAuthMode,
  AppSessionUser,
  GitHubDeviceAuthPoll,
  GitHubDeviceAuthStart,
  UserSession,
} from '@github-personal-assistant/shared';

import { env } from '../config';
import { db, nowIso } from '../db';

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;

type PendingState = {
  redirectUri?: string;
};

type StoredSession = UserSession & {
  authMode: AppAuthMode;
  githubAccessToken: string;
};

type DeviceAuthStatus = 'pending' | 'complete' | 'denied' | 'expired';

type PendingDeviceAuth = GitHubDeviceAuthStart & {
  createdAt: string;
  deviceCode: string;
  nextPollAt: string;
  status: DeviceAuthStatus;
  sessionToken?: string | null;
  error?: string | null;
};

const upsertUserStatement = db.prepare(`
  INSERT INTO users (github_user_id, login, name, avatar_url, created_at, updated_at)
  VALUES (@githubUserId, @login, @name, @avatarUrl, @createdAt, @updatedAt)
  ON CONFLICT(github_user_id) DO UPDATE SET
    login = excluded.login,
    name = excluded.name,
    avatar_url = excluded.avatar_url,
    updated_at = excluded.updated_at
`);

const findExistingDaemonOwnerId = () => {
  const row = db
    .prepare(`
      SELECT github_user_id
      FROM users
      ORDER BY updated_at DESC, created_at DESC, github_user_id DESC
      LIMIT 1
    `)
    .get() as { github_user_id: string } | undefined;
  return row?.github_user_id ?? env.daemonOwnerId;
};

const buildDaemonOwnerUser = (profile?: {
  login?: string;
  name?: string | null;
  avatarUrl?: string;
}): AppSessionUser => ({
  id: findExistingDaemonOwnerId(),
  login: profile?.login?.trim() || env.daemonOwnerLogin,
  name: profile?.name ?? env.daemonOwnerName,
  avatarUrl: profile?.avatarUrl,
});

const prune = () => {
  const now = nowIso();
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM app_sessions WHERE expires_at < ?').run(now);
  db.prepare(
    "UPDATE device_auth_flows SET status = 'expired', error = 'GitHub device code expired. Start sign-in again.' WHERE status = 'pending' AND expires_at < ?",
  ).run(now);
  db.prepare('DELETE FROM device_auth_flows WHERE created_at < ?').run(
    new Date(Date.now() - DEVICE_AUTH_TTL_MS).toISOString(),
  );
};

const toUserSession = (row: {
  session_token: string;
  github_user_id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
}): UserSession => ({
  sessionToken: row.session_token,
  user: {
    id: row.github_user_id,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url ?? undefined,
  },
});

const loadSession = (sessionToken: string): StoredSession | null => {
  const row = db
    .prepare(`
      SELECT s.session_token, s.github_access_token, u.github_user_id, u.login, u.name, u.avatar_url
      FROM app_sessions s
      JOIN users u ON u.github_user_id = s.github_user_id
      WHERE s.session_token = ? AND s.expires_at >= ? AND s.auth_mode = ?
    `)
    .get(sessionToken, nowIso(), env.appAuthMode) as
    | {
        session_token: string;
        github_access_token: string;
        github_user_id: string;
        login: string;
        name: string | null;
        avatar_url: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    ...toUserSession(row),
    authMode: env.appAuthMode,
    githubAccessToken: row.github_access_token,
  };
};

const getDeviceAuthFlow = (flowId: string): PendingDeviceAuth | null => {
  prune();
  const row = db
    .prepare(`
      SELECT flow_id, user_code, verification_uri, verification_uri_complete, expires_at,
             interval_seconds, created_at, device_code, next_poll_at, status, session_token, error
      FROM device_auth_flows
      WHERE flow_id = ?
    `)
    .get(flowId) as
    | {
        flow_id: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string | null;
        expires_at: string;
        interval_seconds: number;
        created_at: string;
        device_code: string;
        next_poll_at: string;
        status: DeviceAuthStatus;
        session_token: string | null;
        error: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    flowId: row.flow_id,
    userCode: row.user_code,
    verificationUri: row.verification_uri,
    verificationUriComplete: row.verification_uri_complete ?? undefined,
    expiresAt: row.expires_at,
    interval: row.interval_seconds,
    createdAt: row.created_at,
    deviceCode: row.device_code,
    nextPollAt: row.next_poll_at,
    status: row.status,
    sessionToken: row.session_token,
    error: row.error,
  };
};

export const createOAuthState = (redirectUri?: string) => {
  prune();
  const state = crypto.randomUUID();
  const createdAt = nowIso();
  db.prepare(
    'INSERT INTO oauth_states (state, redirect_uri, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(state, redirectUri ?? null, createdAt, new Date(Date.now() + STATE_TTL_MS).toISOString());
  return state;
};

export const consumeOAuthState = (state: string): PendingState | null => {
  prune();
  const row = db.prepare('SELECT redirect_uri FROM oauth_states WHERE state = ?').get(state) as
    | { redirect_uri: string | null }
    | undefined;
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  return row ? { redirectUri: row.redirect_uri ?? undefined } : null;
};

export const createAppSession = (input: {
  authMode: AppAuthMode;
  githubAccessToken?: string;
  profile?: {
    login?: string;
    name?: string | null;
    avatarUrl?: string;
  };
}): UserSession => {
  prune();
  const createdAt = nowIso();
  const sessionToken = crypto.randomUUID();
  const user = buildDaemonOwnerUser(input.profile);

  upsertUserStatement.run({
    githubUserId: String(user.id),
    login: user.login,
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? null,
    createdAt,
    updatedAt: createdAt,
  });

  db.prepare(
    `INSERT INTO app_sessions (session_token, github_user_id, github_access_token, auth_mode, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionToken,
    String(user.id),
    input.githubAccessToken ?? '',
    input.authMode,
    createdAt,
    new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  );

  return { sessionToken, user };
};

export const createLocalAppSession = () =>
  createAppSession({
    authMode: 'local',
  });

export const getAppSession = (sessionToken: string | undefined) => {
  if (!sessionToken) {
    return null;
  }

  prune();
  return loadSession(sessionToken);
};

export const destroyAppSession = (sessionToken: string | undefined) => {
  if (!sessionToken) {
    return;
  }

  db.prepare('DELETE FROM app_sessions WHERE session_token = ?').run(sessionToken);
};

export const createDeviceAuth = (input: {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}): GitHubDeviceAuthStart => {
  prune();
  const flowId = crypto.randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + input.expiresIn * 1000).toISOString();
  const nextPollAt = new Date(Date.now() + input.interval * 1000).toISOString();

  db.prepare(`
    INSERT INTO device_auth_flows (
      flow_id, device_code, user_code, verification_uri, verification_uri_complete,
      expires_at, interval_seconds, next_poll_at, status, session_token, error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    flowId,
    input.deviceCode,
    input.userCode,
    input.verificationUri,
    input.verificationUriComplete ?? null,
    expiresAt,
    input.interval,
    nextPollAt,
    'pending',
    null,
    null,
    createdAt,
  );

  return {
    flowId,
    userCode: input.userCode,
    verificationUri: input.verificationUri,
    verificationUriComplete: input.verificationUriComplete,
    expiresAt,
    interval: input.interval,
  };
};

export const getDeviceAuthRecord = (flowId: string) => getDeviceAuthFlow(flowId);

export const scheduleDeviceAuthPoll = (flowId: string, interval?: number) => {
  const deviceAuth = getDeviceAuthFlow(flowId);
  if (!deviceAuth || deviceAuth.status !== 'pending') {
    return null;
  }

  const nextInterval = interval ?? deviceAuth.interval;
  db.prepare(
    'UPDATE device_auth_flows SET interval_seconds = ?, next_poll_at = ? WHERE flow_id = ?',
  ).run(nextInterval, new Date(Date.now() + nextInterval * 1000).toISOString(), flowId);

  return getDeviceAuthFlow(flowId);
};

export const completeDeviceAuth = (flowId: string, session: UserSession) => {
  const deviceAuth = getDeviceAuthFlow(flowId);
  if (!deviceAuth) {
    return null;
  }

  db.prepare("UPDATE device_auth_flows SET status = 'complete', session_token = ?, error = NULL WHERE flow_id = ?").run(
    session.sessionToken,
    flowId,
  );
  return getDeviceAuthFlow(flowId);
};

export const failDeviceAuth = (flowId: string, status: Extract<DeviceAuthStatus, 'denied' | 'expired'>, error: string) => {
  const deviceAuth = getDeviceAuthFlow(flowId);
  if (!deviceAuth) {
    return null;
  }

  db.prepare('UPDATE device_auth_flows SET status = ?, error = ? WHERE flow_id = ?').run(status, error, flowId);
  return getDeviceAuthFlow(flowId);
};

export const getDeviceAuthPollPayload = (flowId: string): GitHubDeviceAuthPoll | null => {
  const deviceAuth = getDeviceAuthFlow(flowId);
  if (!deviceAuth) {
    return null;
  }

  if (deviceAuth.status === 'complete' && deviceAuth.sessionToken) {
    const session = loadSession(deviceAuth.sessionToken);
    if (session) {
      return {
        status: 'complete',
        session: {
          sessionToken: session.sessionToken,
          user: session.user,
        },
      };
    }
  }

  if (deviceAuth.status === 'pending') {
    return {
      status: 'pending',
      flowId: deviceAuth.flowId,
      userCode: deviceAuth.userCode,
      verificationUri: deviceAuth.verificationUri,
      verificationUriComplete: deviceAuth.verificationUriComplete,
      expiresAt: deviceAuth.expiresAt,
      interval: deviceAuth.interval,
    };
  }

  return {
    status: deviceAuth.status === 'denied' ? 'denied' : 'expired',
    error: deviceAuth.error ?? 'GitHub device authorization ended unexpectedly.',
  };
};
