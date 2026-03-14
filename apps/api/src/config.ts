import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';

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
  copilotCliUrl: process.env.COPILOT_CLI_URL,
  copilotGithubToken: process.env.COPILOT_GITHUB_TOKEN,
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

export const isCopilotConfigured = () => Boolean(env.copilotCliUrl || env.copilotGithubToken);
export const canUseCopilot = (githubToken?: string) => Boolean(githubToken || env.copilotCliUrl || env.copilotGithubToken);
export const isDeviceOAuthConfigured = () => Boolean(env.githubClientId);
export const isOAuthConfigured = () => Boolean(env.githubClientId && env.githubClientSecret && env.githubCallbackUrl);
export const isRagFlowConfigured = () => Boolean(env.ragflowBaseUrl && env.ragflowApiKey);
export const isRemoteAccessConfigured = () =>
  Boolean(
    (env.remoteAccessMode === 'tailscale' && env.tailscaleApiUrl) ||
      (env.remoteAccessMode === 'public' && env.publicApiUrl && !/localhost|127\.0\.0\.1/.test(env.publicApiUrl)),
  );
