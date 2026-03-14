import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';
import type { AppAuthMode, CopilotAuthMode, ReasoningEffort } from '@github-personal-assistant/shared';

const loadEnv = () => {
  let currentDir = process.cwd();

  while (true) {
    const envPath = path.join(currentDir, '.env');
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return envPath;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
};

loadEnv();

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value == null) {
    return fallback;
  }

  return !/^(0|false|no|off)$/i.test(value.trim());
};

const parseReasoningEffort = (value: string | undefined): ReasoningEffort | undefined => {
  const normalized = value?.trim();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }
  return undefined;
};

const parseAppAuthMode = (value: string | undefined): AppAuthMode => {
  const normalized = value?.trim();
  if (normalized === 'github-device' || normalized === 'github-oauth' || normalized === 'local') {
    return normalized;
  }
  return 'local';
};

const defaultAppSupportDir = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'github-personal-assistant',
);

const host = process.env.HOST?.trim() || '127.0.0.1';
const port = parseNumber(process.env.PORT, 4000);
const appSupportDir = process.env.APP_SUPPORT_DIR ?? defaultAppSupportDir;
const publicApiUrl = process.env.PUBLIC_API_URL?.trim() || undefined;
const tailscaleApiUrl = process.env.TAILSCALE_API_URL?.trim() || undefined;
const remoteAccessMode =
  (process.env.REMOTE_ACCESS_MODE?.trim() as 'local' | 'tailscale' | 'public' | undefined) ??
  (tailscaleApiUrl ? 'tailscale' : publicApiUrl ? 'public' : 'local');

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host,
  port,
  clientOrigin: process.env.CLIENT_ORIGIN ?? '*',
  publicApiUrl,
  tailscaleApiUrl,
  remoteAccessMode,
  appAuthMode: parseAppAuthMode(process.env.APP_AUTH_MODE),
  daemonOwnerId: process.env.DAEMON_OWNER_ID?.trim() || 'daemon-owner',
  daemonOwnerLogin: process.env.DAEMON_OWNER_LOGIN?.trim() || 'daemon',
  daemonOwnerName: process.env.DAEMON_OWNER_NAME?.trim() || 'Daemon owner',
  copilotCliUrl: process.env.COPILOT_CLI_URL,
  copilotGithubToken: process.env.COPILOT_GITHUB_TOKEN,
  copilotUseLoggedInUser: parseBoolean(process.env.COPILOT_USE_LOGGED_IN_USER, true),
  copilotClientName: process.env.COPILOT_CLIENT_NAME?.trim() || 'github-personal-assistant',
  copilotConfigDir: process.env.COPILOT_CONFIG_DIR ?? path.join(appSupportDir, 'copilot'),
  copilotWorkingDirectory: process.env.COPILOT_WORKING_DIRECTORY ?? process.cwd(),
  copilotInfiniteSessionsEnabled: parseBoolean(process.env.COPILOT_INFINITE_SESSIONS_ENABLED, true),
  copilotBackgroundCompactionThreshold: parseNumber(process.env.COPILOT_BACKGROUND_COMPACTION_THRESHOLD, 0.8),
  copilotBufferExhaustionThreshold: parseNumber(process.env.COPILOT_BUFFER_EXHAUSTION_THRESHOLD, 0.95),
  copilotReasoningEffort: parseReasoningEffort(process.env.COPILOT_REASONING_EFFORT),
  defaultModel: process.env.DEFAULT_MODEL ?? 'gpt-5-mini',
  githubClientId: process.env.GITHUB_CLIENT_ID,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
  githubCallbackUrl: process.env.GITHUB_CALLBACK_URL,
  appSupportDir,
  databasePath: process.env.DATABASE_PATH ?? path.join(appSupportDir, 'data', 'assistant.sqlite'),
  mediaRoot: process.env.MEDIA_ROOT ?? path.join(appSupportDir, 'media'),
  ragflowBaseUrl: process.env.RAGFLOW_BASE_URL?.trim(),
  ragflowApiKey: process.env.RAGFLOW_API_KEY?.trim(),
  ragflowDatasetPrefix: process.env.RAGFLOW_DATASET_PREFIX?.trim() || 'gpa',
  serviceAccessToken: process.env.SERVICE_ACCESS_TOKEN?.trim() || undefined,
};

export const getApiOrigin = () => `http://${env.host}:${env.port}`;

export const isCopilotConfigured = () => Boolean(env.copilotCliUrl || env.copilotGithubToken || env.copilotUseLoggedInUser);
export const canUseCopilot = (githubToken?: string) =>
  Boolean(githubToken || env.copilotCliUrl || env.copilotGithubToken || env.copilotUseLoggedInUser);
export const isDeviceOAuthConfigured = () => Boolean(env.githubClientId);
export const isOAuthConfigured = () => Boolean(env.githubClientId && env.githubClientSecret && env.githubCallbackUrl);
export const isRagFlowConfigured = () => Boolean(env.ragflowBaseUrl && env.ragflowApiKey);
export const isRemoteAccessConfigured = () =>
  Boolean(
    (env.remoteAccessMode === 'tailscale' && env.tailscaleApiUrl) ||
      (env.remoteAccessMode === 'public' && env.publicApiUrl && !/localhost|127\.0\.0\.1/.test(env.publicApiUrl)),
  );

export const getCopilotAuthMode = (): CopilotAuthMode => {
  if (env.copilotCliUrl) {
    return 'cli-url';
  }
  if (env.copilotGithubToken) {
    return 'github-token';
  }
  if (env.copilotUseLoggedInUser) {
    return 'logged-in-user';
  }
  return 'unconfigured';
};

export const isActiveAppAuthConfigured = () => {
  switch (env.appAuthMode) {
    case 'local':
      return true;
    case 'github-device':
      return isDeviceOAuthConfigured();
    case 'github-oauth':
      return isOAuthConfigured();
  }
};

export const getAuthConfigVersion = () =>
  crypto
    .createHash('sha1')
    .update(
      JSON.stringify({
        appAuthMode: env.appAuthMode,
        serviceAccessToken: Boolean(env.serviceAccessToken),
        githubDeviceConfigured: isDeviceOAuthConfigured(),
        githubOAuthConfigured: isOAuthConfigured(),
      }),
    )
    .digest('hex')
    .slice(0, 12);
