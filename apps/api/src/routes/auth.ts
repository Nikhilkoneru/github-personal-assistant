import { Router } from 'express';
import { z } from 'zod';

import type { AuthCapabilities, GitHubDeviceAuthPoll } from '@github-personal-assistant/shared';

import { env, getAuthConfigVersion, getCopilotAuthMode, isActiveAppAuthConfigured, isDeviceOAuthConfigured, isOAuthConfigured } from '../config';
import { getRequestSession, requireServiceAccess } from '../lib/auth';
import {
  completeDeviceAuth,
  consumeOAuthState,
  createAppSession,
  createLocalAppSession,
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
const ACTIVE_AUTH_MODE_ERROR = 'GitHub sign-in is disabled because the daemon is not using a GitHub app-auth mode right now.';

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

const getGitHubUserProfile = async (accessToken: string) => {
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
    login: githubUser.login,
    name: githubUser.name,
    avatarUrl: githubUser.avatar_url,
  };
};

const createSessionFromGitHubAccessToken = async (accessToken: string) =>
  createAppSession({
    authMode: env.appAuthMode,
    githubAccessToken: accessToken,
    profile: await getGitHubUserProfile(accessToken),
  });

const buildAuthCapabilities = (): AuthCapabilities => {
  const authConfigured = isActiveAppAuthConfigured();
  const signIn =
    env.appAuthMode === 'local'
      ? {
          label: 'Continue to local daemon',
          description: 'This daemon is configured for trusted local access and can create a session automatically.',
          automatic: true,
          localBootstrap: true,
          deviceFlow: false,
          redirectFlow: false,
        }
      : env.appAuthMode === 'github-device'
        ? {
            label: 'Sign in with GitHub',
            description: 'Open GitHub device verification, confirm the code, and this client will finish sign-in automatically.',
            automatic: false,
            localBootstrap: false,
            deviceFlow: true,
            redirectFlow: false,
          }
        : {
            label: 'Continue with GitHub',
            description: 'Open the backend-managed GitHub OAuth flow and return here once the daemon has created your session.',
            automatic: false,
            localBootstrap: false,
            deviceFlow: false,
            redirectFlow: true,
          };

  return {
    mode: env.appAuthMode,
    supportedModes: [env.appAuthMode],
    backendHandled: true,
    sessionRequired: true,
    serviceTokenRequired: Boolean(env.serviceAccessToken),
    authConfigured,
    version: getAuthConfigVersion(),
    copilotAuthMode: getCopilotAuthMode(),
    signIn,
  };
};

router.get('/api/auth/capabilities', (request, response) => {
  if (!requireServiceAccess(request, response)) {
    return;
  }

  response.json(buildAuthCapabilities());
});

router.get('/api/auth/session', (request, response) => {
  if (!requireServiceAccess(request, response)) {
    return;
  }

  const session = getRequestSession(request);
  response.json({ session: session ? { sessionToken: session.sessionToken, user: session.user } : null });
});

router.post('/api/auth/local/session', (request, response) => {
  if (!requireServiceAccess(request, response)) {
    return;
  }

  if (env.appAuthMode !== 'local') {
    response.status(409).json({ error: 'Local auth is not active on this daemon right now.' });
    return;
  }

  const existingSession = getRequestSession(request);
  if (existingSession) {
    response.status(201).json({ session: { sessionToken: existingSession.sessionToken, user: existingSession.user } });
    return;
  }

  const session = createLocalAppSession();
  response.status(201).json({ session });
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

  if (env.appAuthMode !== 'github-oauth') {
    response.status(409).json({ error: ACTIVE_AUTH_MODE_ERROR });
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

  if (env.appAuthMode !== 'github-device') {
    response.status(409).json({ error: ACTIVE_AUTH_MODE_ERROR });
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

  if (env.appAuthMode !== 'github-device') {
    response.status(409).json({ error: ACTIVE_AUTH_MODE_ERROR });
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
  if (env.appAuthMode !== 'github-oauth') {
    response.status(409).json({ error: ACTIVE_AUTH_MODE_ERROR });
    return;
  }

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
