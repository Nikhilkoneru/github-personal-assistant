import { Router } from 'express';
import { z } from 'zod';

import type { AppSessionUser, GitHubDeviceAuthPoll } from '@github-personal-assistant/shared';

import { env, isDeviceOAuthConfigured, isOAuthConfigured } from '../config';
import { getRequestSession, requireServiceAccess } from '../lib/auth';
import {
  completeDeviceAuth,
  consumeOAuthState,
  createAppSession,
  createDeviceAuth,
  createOAuthState,
  destroyAppSession,
  failDeviceAuth,
  getDeviceAuthPollPayload,
  getDeviceAuthRecord,
  scheduleDeviceAuthPoll,
} from '../store/auth-store';

const router = Router();
const GITHUB_SCOPE = 'read:user user:email';
const DEVICE_AUTH_CONFIG_ERROR =
  'GitHub device OAuth is not configured on the backend yet. Copy .env.example to .env, set GITHUB_CLIENT_ID, and restart the API.';

const authStartSchema = z.object({
  redirectUri: z.string().url().optional(),
});

const deviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url().optional(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5),
});

const deviceTokenResponseSchema = z.object({
  access_token: z.string().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const getGitHubUser = async (accessToken: string): Promise<AppSessionUser> => {
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!userResponse.ok) {
    throw new Error('Failed to load the signed-in GitHub user.');
  }

  const githubUser = (await userResponse.json()) as {
    id: number;
    login: string;
    name?: string | null;
    avatar_url?: string;
  };

  return {
    id: githubUser.id,
    login: githubUser.login,
    name: githubUser.name,
    avatarUrl: githubUser.avatar_url,
  };
};

const createSessionFromGitHubAccessToken = async (accessToken: string) =>
  createAppSession(accessToken, await getGitHubUser(accessToken));

router.get('/api/auth/session', (request, response) => {
  if (!requireServiceAccess(request, response)) {
    return;
  }

  const session = getRequestSession(request);
  response.json({ session: session ? { sessionToken: session.sessionToken, user: session.user } : null });
});

router.post('/api/auth/logout', (request, response) => {
  if (!requireServiceAccess(request, response)) {
    return;
  }

  const session = getRequestSession(request);
  destroyAppSession(session?.sessionToken);
  response.status(204).end();
});

router.get('/api/auth/github/url', (request, response) => {
  if (!requireServiceAccess(request, response)) {
    return;
  }

  if (!isOAuthConfigured()) {
    response.status(503).json({ error: 'GitHub OAuth is not configured on the backend yet.' });
    return;
  }

  const parsed = authStartSchema.safeParse({ redirectUri: request.query.redirectUri });
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const state = createOAuthState(parsed.data.redirectUri);
  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', env.githubClientId!);
  authorizeUrl.searchParams.set('redirect_uri', env.githubCallbackUrl!);
  authorizeUrl.searchParams.set('scope', GITHUB_SCOPE);
  authorizeUrl.searchParams.set('state', state);

  response.json({ authorizeUrl: authorizeUrl.toString() });
});

router.post('/api/auth/github/device/start', async (_request, response) => {
  if (!requireServiceAccess(_request, response)) {
    return;
  }

  if (!isDeviceOAuthConfigured()) {
    response.status(503).json({ error: DEVICE_AUTH_CONFIG_ERROR });
    return;
  }

  const deviceCodeResponse = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.githubClientId,
      scope: GITHUB_SCOPE,
    }),
  });

  if (!deviceCodeResponse.ok) {
    response.status(502).json({ error: 'Failed to start the GitHub device authorization flow.' });
    return;
  }

  const parsed = deviceCodeResponseSchema.safeParse(await deviceCodeResponse.json());
  if (!parsed.success) {
    response.status(502).json({ error: 'GitHub returned an unexpected device authorization response.' });
    return;
  }

  const deviceAuth = createDeviceAuth({
    deviceCode: parsed.data.device_code,
    userCode: parsed.data.user_code,
    verificationUri: parsed.data.verification_uri,
    verificationUriComplete: parsed.data.verification_uri_complete,
    expiresIn: parsed.data.expires_in,
    interval: parsed.data.interval,
  });

  response.status(201).json(deviceAuth);
});

router.get('/api/auth/github/device/:flowId', async (request, response) => {
  if (!requireServiceAccess(request, response)) {
    return;
  }

  if (!isDeviceOAuthConfigured()) {
    response.status(503).json({ error: DEVICE_AUTH_CONFIG_ERROR });
    return;
  }

  const flowId = request.params.flowId;
  const deviceAuth = getDeviceAuthRecord(flowId);
  if (!deviceAuth) {
    response.json({
      status: 'expired',
      error: 'GitHub device code expired. Start sign-in again.',
    } satisfies GitHubDeviceAuthPoll);
    return;
  }

  const currentPayload = getDeviceAuthPollPayload(flowId);
  if (currentPayload && currentPayload.status !== 'pending') {
    response.json(currentPayload);
    return;
  }

  if (Date.now() < new Date(deviceAuth.nextPollAt).getTime()) {
    response.json(currentPayload);
    return;
  }

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.githubClientId,
      device_code: deviceAuth.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  if (!tokenResponse.ok) {
    response.status(502).json({ error: 'Failed to poll GitHub device authorization.' });
    return;
  }

  const parsed = deviceTokenResponseSchema.safeParse(await tokenResponse.json());
  if (!parsed.success) {
    response.status(502).json({ error: 'GitHub returned an unexpected device authorization token response.' });
    return;
  }

  if (parsed.data.access_token) {
    try {
      const session = await createSessionFromGitHubAccessToken(parsed.data.access_token);
      completeDeviceAuth(flowId, session);
      response.json({
        status: 'complete',
        session,
      } satisfies GitHubDeviceAuthPoll);
      return;
    } catch (error) {
      response.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to create an app session from the GitHub device token.',
      });
      return;
    }
  }

  switch (parsed.data.error) {
    case 'authorization_pending': {
      scheduleDeviceAuthPoll(flowId);
      response.json(getDeviceAuthPollPayload(flowId));
      return;
    }
    case 'slow_down': {
      scheduleDeviceAuthPoll(flowId, deviceAuth.interval + 5);
      response.json(getDeviceAuthPollPayload(flowId));
      return;
    }
    case 'access_denied': {
      failDeviceAuth(flowId, 'denied', 'GitHub device authorization was denied.');
      response.json(getDeviceAuthPollPayload(flowId));
      return;
    }
    case 'expired_token': {
      failDeviceAuth(flowId, 'expired', 'GitHub device code expired. Start sign-in again.');
      response.json(getDeviceAuthPollPayload(flowId));
      return;
    }
    default: {
      response.status(502).json({
        error: parsed.data.error_description ?? 'GitHub returned an unexpected device authorization state.',
      });
    }
  }
});

router.get('/api/auth/github/callback', async (request, response) => {
  if (!isOAuthConfigured()) {
    response.status(503).json({ error: 'GitHub OAuth is not configured on the backend yet.' });
    return;
  }

  const code = typeof request.query.code === 'string' ? request.query.code : undefined;
  const state = typeof request.query.state === 'string' ? request.query.state : undefined;

  if (!code || !state) {
    response.status(400).json({ error: 'Missing code or state.' });
    return;
  }

  const pendingState = consumeOAuthState(state);
  if (!pendingState) {
    response.status(400).json({ error: 'Invalid or expired OAuth state.' });
    return;
  }

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.githubClientId,
      client_secret: env.githubClientSecret,
      code,
      redirect_uri: env.githubCallbackUrl,
    }),
  });

  if (!tokenResponse.ok) {
    response.status(502).json({ error: 'Failed to exchange GitHub OAuth code.' });
    return;
  }

  const tokenPayload = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenPayload.access_token) {
    response.status(502).json({ error: 'GitHub OAuth did not return an access token.' });
    return;
  }

  let appSession;
  try {
    appSession = await createSessionFromGitHubAccessToken(tokenPayload.access_token);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : 'Failed to load the signed-in GitHub user.' });
    return;
  }

  if (pendingState.redirectUri) {
    const redirectUrl = new URL(pendingState.redirectUri);
    redirectUrl.searchParams.set('sessionToken', appSession.sessionToken);
    redirectUrl.searchParams.set('login', appSession.user.login);
    response.redirect(redirectUrl.toString());
    return;
  }

  response.json({ session: appSession });
});

export default router;
