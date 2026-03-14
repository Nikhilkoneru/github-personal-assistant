import fs from 'node:fs';

import { z } from 'zod';

import type { CopilotClient, CopilotSession, ResumeSessionConfig, SessionConfig } from '@github/copilot-sdk';
import type {
  AttachmentSummary,
  CopilotAuthStatus,
  CopilotSessionSummary,
  CopilotStatusResponse,
  ModelOption,
  ReasoningEffort,
} from '@github-personal-assistant/shared';

import { env, canUseCopilot } from '../config';
import { buildKnowledgePromptContext } from './retrieval';
import { getThreadDetail } from '../store/thread-store';

type CopilotSdkModule = typeof import('@github/copilot-sdk');

const clients = new Map<string, Promise<CopilotClient>>();
let sdkModulePromise: Promise<CopilotSdkModule> | null = null;

const makeKey = (githubToken?: string) => (githubToken ? `user:${githubToken.slice(-12)}` : 'service');

const loadSdkModule = () => {
  sdkModulePromise ??= import('@github/copilot-sdk');
  return sdkModulePromise;
};

const toIsoString = (value: Date | string) => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

export const getCopilotClient = async (githubToken?: string) => {
  const key = makeKey(githubToken);
  const existing = clients.get(key);
  if (existing) {
    return existing;
  }

  const clientPromise = (async () => {
    const { CopilotClient } = await loadSdkModule();
    const client = new CopilotClient({
      ...(env.copilotCliUrl ? { cliUrl: env.copilotCliUrl, useStdio: false } : {}),
      ...(githubToken
        ? { githubToken, useLoggedInUser: false }
        : env.copilotGithubToken
          ? { githubToken: env.copilotGithubToken, useLoggedInUser: false }
          : env.copilotUseLoggedInUser
            ? { useLoggedInUser: true }
            : {}),
    });
    await client.start();
    return client;
  })();

  clients.set(key, clientPromise);

  try {
    return await clientPromise;
  } catch (error) {
    clients.delete(key);
    throw error;
  }
};

type ModelInfoLike = {
  id: string;
  name: string;
  capabilities?: {
    supports?: {
      vision?: boolean;
      reasoningEffort?: boolean;
    };
    limits?: {
      max_prompt_tokens?: number;
      max_context_window_tokens?: number;
      vision?: {
        supported_media_types?: string[];
        max_prompt_images?: number;
        max_prompt_image_size?: number;
      };
    };
  };
  policy?: {
    state?: 'enabled' | 'disabled' | 'unconfigured';
    terms?: string;
  };
  billing?: {
    multiplier?: number;
  };
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
};

export const listModels = async (githubToken?: string): Promise<ModelOption[]> => {
  if (!canUseCopilot(githubToken)) {
    throw new Error('Copilot is not configured for this session.');
  }

  const client = await getCopilotClient(githubToken);
  const result = await client.listModels();

  return (result as ModelInfoLike[]).map((model) => ({
    id: model.id,
    name: model.name,
    source: 'sdk',
    supportsReasoning: Boolean(model.capabilities?.supports?.reasoningEffort),
    capabilities: model.capabilities
      ? {
          supports: {
            vision: Boolean(model.capabilities.supports?.vision),
            reasoningEffort: Boolean(model.capabilities.supports?.reasoningEffort),
          },
          limits: {
            ...(typeof model.capabilities.limits?.max_prompt_tokens === 'number'
              ? { maxPromptTokens: model.capabilities.limits.max_prompt_tokens }
              : {}),
            maxContextWindowTokens: model.capabilities.limits?.max_context_window_tokens ?? 0,
            ...(model.capabilities.limits?.vision
              ? {
                  vision: {
                    supportedMediaTypes: model.capabilities.limits.vision.supported_media_types ?? [],
                    maxPromptImages: model.capabilities.limits.vision.max_prompt_images ?? 0,
                    maxPromptImageSize: model.capabilities.limits.vision.max_prompt_image_size ?? 0,
                  },
                }
              : {}),
          },
        }
      : undefined,
    policy:
      model.policy?.state && model.policy?.terms
        ? {
            state: model.policy.state,
            terms: model.policy.terms,
          }
        : undefined,
    billing:
      typeof model.billing?.multiplier === 'number'
        ? {
            multiplier: model.billing.multiplier,
          }
        : undefined,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
  }));
};

type SessionMetadataLike = {
  sessionId: string;
  startTime: Date | string;
  modifiedTime: Date | string;
  summary?: string;
  isRemote: boolean;
  context?: {
    cwd: string;
    gitRoot?: string;
    repository?: string;
    branch?: string;
  };
};

type StatusLike = {
  version: string;
  protocolVersion: number;
};

type AuthStatusLike = CopilotAuthStatus;

export const getCopilotOverview = async (
  githubToken?: string,
  filter?: { cwd?: string; gitRoot?: string; repository?: string; branch?: string },
): Promise<CopilotStatusResponse> => {
  if (!canUseCopilot(githubToken)) {
    throw new Error('Copilot is not configured for this session.');
  }

  const client = await getCopilotClient(githubToken);
  const [status, auth, sessions, lastSessionId] = await Promise.all([
    client.getStatus() as Promise<StatusLike>,
    client.getAuthStatus() as Promise<AuthStatusLike>,
    client.listSessions(filter) as Promise<SessionMetadataLike[]>,
    client.getLastSessionId().catch(() => undefined),
  ]);

  return {
    status: {
      version: status.version,
      protocolVersion: status.protocolVersion,
      connectionState: client.getState(),
    },
    auth: {
      isAuthenticated: auth.isAuthenticated,
      authType: auth.authType,
      host: auth.host,
      login: auth.login,
      statusMessage: auth.statusMessage,
    },
    sessions: sessions.map(
      (session): CopilotSessionSummary => ({
        sessionId: session.sessionId,
        startTime: toIsoString(session.startTime),
        modifiedTime: toIsoString(session.modifiedTime),
        summary: session.summary,
        isRemote: session.isRemote,
        context: session.context,
      }),
    ),
    ...(lastSessionId ? { lastSessionId } : {}),
  };
};

export const deleteCopilotSession = async (githubToken: string | undefined, sessionId: string) => {
  if (!canUseCopilot(githubToken)) {
    throw new Error('Copilot is not configured for this session.');
  }

  const client = await getCopilotClient(githubToken);
  await client.deleteSession(sessionId);
};

const listThreadAttachments = (ownerId: string, threadId: string): AttachmentSummary[] => {
  const detail = getThreadDetail(ownerId, threadId);
  if (!detail) {
    return [];
  }

  const attachments = new Map<string, AttachmentSummary>();
  for (const message of detail.messages) {
    for (const attachment of message.attachments ?? []) {
      attachments.set(attachment.id, attachment);
    }
  }

  return Array.from(attachments.values());
};

const createSessionTools = async (ownerId: string, threadId: string) => {
  const { defineTool } = await loadSdkModule();
  const lookupSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The focused project-knowledge question to look up before answering.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  } satisfies Record<string, unknown>;

  return [
    defineTool('lookup_project_knowledge', {
      description: 'Search the project knowledge connected to this chat thread and return the most relevant grounding context.',
      parameters: lookupSchema,
      handler: async (args) => {
        const { query } = z.object({ query: z.string().min(1) }).parse(args);
        const context = await buildKnowledgePromptContext({
          ownerId,
          threadId,
          query,
        });

        return context || 'No project knowledge is currently available for this thread.';
      },
    }),
    defineTool('list_thread_attachments', {
      description: 'List files that have already been attached in this chat thread.',
      handler: () => {
        const attachments = listThreadAttachments(ownerId, threadId);
        if (attachments.length === 0) {
          return 'No attachments have been added to this thread yet.';
        }

        return attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          kind: attachment.kind,
          scope: attachment.scope,
          knowledgeStatus: attachment.knowledgeStatus,
          uploadedAt: attachment.uploadedAt,
        }));
      },
    }),
  ];
};

export const getOrCreateSession = async ({
  sessionId,
  githubToken,
  ownerId,
  threadId,
  model,
  systemMessage,
}: {
  sessionId: string;
  githubToken?: string;
  ownerId: string;
  threadId: string;
  model: string;
  systemMessage?: string;
}): Promise<CopilotSession> => {
  const [{ approveAll }, client] = await Promise.all([
    loadSdkModule(),
    getCopilotClient(githubToken),
  ]);

  fs.mkdirSync(env.copilotConfigDir, { recursive: true });
  fs.mkdirSync(env.copilotWorkingDirectory, { recursive: true });
  const tools = await createSessionTools(ownerId, threadId);
  const config: Omit<SessionConfig, 'sessionId'> & ResumeSessionConfig = {
    clientName: env.copilotClientName,
    configDir: env.copilotConfigDir,
    workingDirectory: env.copilotWorkingDirectory,
    model,
    streaming: true,
    tools,
    onPermissionRequest: approveAll,
    infiniteSessions: env.copilotInfiniteSessionsEnabled
      ? {
          enabled: true,
          backgroundCompactionThreshold: env.copilotBackgroundCompactionThreshold,
          bufferExhaustionThreshold: env.copilotBufferExhaustionThreshold,
        }
      : { enabled: false },
    ...(env.copilotReasoningEffort ? { reasoningEffort: env.copilotReasoningEffort as ReasoningEffort } : {}),
    ...(systemMessage
      ? {
          systemMessage: {
            mode: 'append',
            content: systemMessage,
          },
        }
      : {}),
  };

  try {
    return await client.resumeSession(sessionId, config);
  } catch {
    return client.createSession({
      sessionId,
      ...config,
    });
  }
};
