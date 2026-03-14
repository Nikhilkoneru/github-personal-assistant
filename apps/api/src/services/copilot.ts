import crypto from 'node:crypto';
import fs from 'node:fs';

import type { CopilotClient, CopilotSession, ResumeSessionConfig, SessionConfig } from '@github/copilot-sdk';
import type {
  AttachmentSummary,
  ChatMessage,
  ChatToolActivity,
  ChatUsage,
  ChatUserInputRequest,
  CopilotApprovalMode,
  CopilotAuthStatus,
  CopilotSessionSummary,
  CopilotStatusResponse,
  ModelOption,
  ReasoningEffort,
  ThreadDetail,
  ThreadSummary,
} from '@github-personal-assistant/shared';

import { env, canUseCopilot } from '../config.js';
import type { ThreadAttachmentReference } from '../store/attachment-store.js';
import { listThreadAttachmentReferences } from '../store/attachment-store.js';

type CopilotSdkModule = typeof import('@github/copilot-sdk');
type SessionEvent = Awaited<ReturnType<CopilotSession['getMessages']>>[number];

type ToolActivityHandler = (activity: ChatToolActivity) => void;
type UserInputResponder = {
  answer: string;
  wasFreeform: boolean;
};
type UserInputHandler = (request: ChatUserInputRequest) => Promise<UserInputResponder>;

const clients = new Map<string, Promise<CopilotClient>>();
let sdkModulePromise: Promise<CopilotSdkModule> | null = null;

const makeKey = (githubToken?: string) => (githubToken ? `user:${githubToken.slice(-12)}` : 'service');

const loadSdkModule = () => {
  sdkModulePromise ??= import('@github/copilot-sdk');
  return sdkModulePromise;
};

const createPermissionHandler = (approvalMode: CopilotApprovalMode) => (request: { kind: string }) => {
  if (approvalMode === 'approve-all') {
    return { kind: 'approved' as const };
  }

  if (request.kind === 'read' || request.kind === 'url' || request.kind === 'custom-tool') {
    return { kind: 'approved' as const };
  }

  return { kind: 'denied-no-approval-rule-and-could-not-request-from-user' as const };
};

const toIsoString = (value: Date | string) => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

const serializeUnknown = (value: unknown) => {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const ensureMessageMetadata = (message: ChatMessage) => {
  message.metadata ??= {};
  return message.metadata;
};

const upsertToolActivity = (message: ChatMessage, activity: ChatToolActivity) => {
  const metadata = ensureMessageMetadata(message);
  const activities = metadata.toolActivities ?? [];
  const existingIndex = activities.findIndex((entry) => entry.id === activity.id);
  if (existingIndex >= 0) {
    activities[existingIndex] = {
      ...activities[existingIndex],
      ...activity,
    };
  } else {
    activities.push(activity);
  }
  metadata.toolActivities = activities;
};

const mergeUsage = (current: ChatUsage | undefined, next: ChatUsage): ChatUsage => ({
  ...(current ?? { model: next.model }),
  ...next,
});

const buildAttachmentIndexes = (attachments: ThreadAttachmentReference[]) => ({
  byPath: new Map(attachments.map((attachment) => [attachment.filePath, attachment])),
  byName: attachments.reduce((map, attachment) => {
    const existing = map.get(attachment.name) ?? [];
    existing.push(attachment);
    map.set(attachment.name, existing);
    return map;
  }, new Map<string, ThreadAttachmentReference[]>()),
});

const mapSessionAttachments = (
  attachments: Extract<SessionEvent, { type: 'user.message' }>['data']['attachments'] | undefined,
  indexes: ReturnType<typeof buildAttachmentIndexes>,
): AttachmentSummary[] => {
  const matched = new Map<string, AttachmentSummary>();

  for (const attachment of attachments ?? []) {
    if (attachment.type !== 'file') {
      continue;
    }

    const byPath = indexes.byPath.get(attachment.path);
    if (byPath) {
      matched.set(byPath.id, byPath);
      continue;
    }

    const byName = indexes.byName.get(attachment.displayName);
    for (const candidate of byName ?? []) {
      matched.set(candidate.id, candidate);
    }
  }

  return Array.from(matched.values());
};

const parseThreadMessages = (events: SessionEvent[], attachments: ThreadAttachmentReference[]) => {
  const messages: ChatMessage[] = [];
  const assistantByMessageId = new Map<string, ChatMessage>();
  const toolOwnerByCallId = new Map<string, ChatMessage>();
  const attachmentIndexes = buildAttachmentIndexes(attachments);
  let lastAssistant: ChatMessage | null = null;
  let pendingReasoning: string | undefined;
  let pendingUserInputRequest: ChatUserInputRequest | undefined;

  for (const event of events) {
    switch (event.type) {
      case 'user.message': {
        if (event.data.source?.startsWith('skill-')) {
          continue;
        }

        const eventAttachments = mapSessionAttachments(event.data.attachments, attachmentIndexes);
        messages.push({
          id: event.id,
          role: 'user',
          content: event.data.content,
          createdAt: event.timestamp,
          ...(eventAttachments.length > 0 ? { attachments: eventAttachments } : {}),
        });
        break;
      }

      case 'assistant.reasoning': {
        pendingReasoning = event.data.content;
        break;
      }

      case 'assistant.message': {
        if (event.data.parentToolCallId) {
          break;
        }

        const toolActivities =
          event.data.toolRequests?.map(
            (request): ChatToolActivity => ({
              id: request.toolCallId,
              toolName: request.name,
              status: 'running',
              startedAt: event.timestamp,
              updatedAt: event.timestamp,
              arguments: serializeUnknown(request.arguments),
            }),
          ) ?? [];

        const message: ChatMessage = {
          id: event.data.messageId,
          role: 'assistant',
          content: event.data.content,
          createdAt: event.timestamp,
          metadata: {
            sessionMessageId: event.data.messageId,
            ...(event.data.phase ? { phase: event.data.phase } : {}),
            ...(event.data.reasoningText || pendingReasoning
              ? { reasoning: event.data.reasoningText ?? pendingReasoning, reasoningState: 'complete' as const }
              : {}),
            ...(toolActivities.length > 0 ? { toolActivities } : {}),
          },
        };

        pendingReasoning = undefined;
        messages.push(message);
        assistantByMessageId.set(event.data.messageId, message);
        for (const activity of toolActivities) {
          toolOwnerByCallId.set(activity.id, message);
        }
        lastAssistant = message;
        break;
      }

      case 'assistant.usage': {
        if (!lastAssistant) {
          break;
        }

        const metadata = ensureMessageMetadata(lastAssistant);
        metadata.usage = mergeUsage(metadata.usage, {
          model: event.data.model,
          inputTokens: event.data.inputTokens,
          outputTokens: event.data.outputTokens,
          cacheReadTokens: event.data.cacheReadTokens,
          cacheWriteTokens: event.data.cacheWriteTokens,
          cost: event.data.cost,
          duration: event.data.duration,
          initiator: event.data.initiator,
        });
        break;
      }

      case 'tool.execution_start': {
        const owner = toolOwnerByCallId.get(event.data.toolCallId) ?? lastAssistant;
        if (!owner) {
          break;
        }

        upsertToolActivity(owner, {
          id: event.data.toolCallId,
          toolName: event.data.toolName,
          status: 'running',
          startedAt: event.timestamp,
          updatedAt: event.timestamp,
          arguments: serializeUnknown(event.data.arguments),
        });
        toolOwnerByCallId.set(event.data.toolCallId, owner);
        break;
      }

      case 'tool.execution_progress': {
        const owner = toolOwnerByCallId.get(event.data.toolCallId);
        if (!owner) {
          break;
        }

        upsertToolActivity(owner, {
          id: event.data.toolCallId,
          toolName: owner.metadata?.toolActivities?.find((entry) => entry.id === event.data.toolCallId)?.toolName ?? 'Tool',
          status: 'running',
          startedAt: owner.metadata?.toolActivities?.find((entry) => entry.id === event.data.toolCallId)?.startedAt ?? event.timestamp,
          updatedAt: event.timestamp,
          additionalContext: event.data.progressMessage,
        });
        break;
      }

      case 'tool.execution_partial_result': {
        const owner = toolOwnerByCallId.get(event.data.toolCallId);
        if (!owner) {
          break;
        }

        upsertToolActivity(owner, {
          id: event.data.toolCallId,
          toolName: owner.metadata?.toolActivities?.find((entry) => entry.id === event.data.toolCallId)?.toolName ?? 'Tool',
          status: 'running',
          startedAt: owner.metadata?.toolActivities?.find((entry) => entry.id === event.data.toolCallId)?.startedAt ?? event.timestamp,
          updatedAt: event.timestamp,
          result: event.data.partialOutput,
        });
        break;
      }

      case 'tool.execution_complete': {
        const owner = toolOwnerByCallId.get(event.data.toolCallId) ?? lastAssistant;
        if (!owner) {
          break;
        }

        upsertToolActivity(owner, {
          id: event.data.toolCallId,
          toolName: owner.metadata?.toolActivities?.find((entry) => entry.id === event.data.toolCallId)?.toolName ?? 'Tool',
          status: event.data.success ? 'completed' : 'failed',
          startedAt: owner.metadata?.toolActivities?.find((entry) => entry.id === event.data.toolCallId)?.startedAt ?? event.timestamp,
          updatedAt: event.timestamp,
          result: event.data.result?.detailedContent ?? event.data.result?.content,
          error:
            'error' in event.data && event.data.error && typeof event.data.error.message === 'string'
              ? event.data.error.message
              : undefined,
        });
        break;
      }

      case 'permission.requested': {
        const toolCallId = event.data.permissionRequest.toolCallId;
        const owner = toolCallId ? toolOwnerByCallId.get(toolCallId) ?? lastAssistant : null;
        if (!owner || !toolCallId) {
          break;
        }

        upsertToolActivity(owner, {
          id: toolCallId,
          toolName: owner.metadata?.toolActivities?.find((entry) => entry.id === toolCallId)?.toolName ?? 'Tool',
          status: 'running',
          startedAt: owner.metadata?.toolActivities?.find((entry) => entry.id === toolCallId)?.startedAt ?? event.timestamp,
          updatedAt: event.timestamp,
          permissionDecision: 'ask',
          permissionDecisionReason: 'Permission requested',
        });
        break;
      }

      case 'user_input.requested': {
        pendingUserInputRequest = {
          requestId: event.data.requestId,
          question: event.data.question,
          choices: event.data.choices,
          allowFreeform: event.data.allowFreeform ?? true,
          createdAt: event.timestamp,
        };
        break;
      }

      case 'user_input.completed': {
        if (pendingUserInputRequest?.requestId === event.data.requestId) {
          pendingUserInputRequest = undefined;
        }
        break;
      }
    }
  }

  return { messages, pendingUserInputRequest };
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

const createSessionTools = async (ownerId: string, threadId: string) => {
  const { defineTool } = await loadSdkModule();

  return [
    defineTool('list_thread_attachments', {
      description: 'List files that have already been attached in this chat thread.',
      handler: () => {
        const attachments = listThreadAttachmentReferences(ownerId, threadId);
        if (attachments.length === 0) {
          return 'No attachments have been added to this thread yet.';
        }

        return attachments.map(({ filePath: _filePath, ...attachment }) => attachment);
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
  reasoningEffort,
  approvalMode,
  systemMessage,
  onUserInputRequest,
  onToolActivity,
  createIfMissing = true,
}: {
  sessionId: string;
  githubToken?: string;
  ownerId: string;
  threadId: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  approvalMode: CopilotApprovalMode;
  systemMessage?: string;
  onUserInputRequest?: UserInputHandler;
  onToolActivity?: ToolActivityHandler;
  createIfMissing?: boolean;
}): Promise<CopilotSession | null> => {
  const client = await getCopilotClient(githubToken);

  fs.mkdirSync(env.copilotConfigDir, { recursive: true });
  fs.mkdirSync(env.copilotWorkingDirectory, { recursive: true });
  const tools = await createSessionTools(ownerId, threadId);
  const hooks = onToolActivity
    ? {
        onPreToolUse: (input: { toolName: string; toolArgs: unknown }, invocation: { sessionId: string }) => {
          onToolActivity({
            id: `${invocation.sessionId}:${input.toolName}:${crypto.randomUUID()}`,
            toolName: input.toolName,
            status: 'running',
            startedAt: now(),
            updatedAt: now(),
            arguments: serializeUnknown(input.toolArgs),
          });
        },
        onPostToolUse: (input: { toolName: string; toolArgs: unknown; toolResult: unknown }, invocation: { sessionId: string }) => {
          onToolActivity({
            id: `${invocation.sessionId}:${input.toolName}:${crypto.randomUUID()}`,
            toolName: input.toolName,
            status: 'completed',
            startedAt: now(),
            updatedAt: now(),
            arguments: serializeUnknown(input.toolArgs),
            result: serializeUnknown(input.toolResult),
          });
        },
      }
    : undefined;

  const config: Omit<SessionConfig, 'sessionId'> & ResumeSessionConfig = {
    clientName: env.copilotClientName,
    configDir: env.copilotConfigDir,
    workingDirectory: env.copilotWorkingDirectory,
    model,
    streaming: true,
    tools,
    onPermissionRequest: createPermissionHandler(approvalMode),
    ...(onUserInputRequest
      ? {
          onUserInputRequest: async (request: { question: string; choices?: string[]; allowFreeform?: boolean }) =>
            onUserInputRequest({
              requestId: crypto.randomUUID(),
              question: request.question,
              choices: request.choices,
              allowFreeform: request.allowFreeform ?? true,
              createdAt: now(),
            }),
        }
      : {}),
    ...(hooks ? { hooks } : {}),
    infiniteSessions: env.copilotInfiniteSessionsEnabled
      ? {
          enabled: true,
          backgroundCompactionThreshold: env.copilotBackgroundCompactionThreshold,
          bufferExhaustionThreshold: env.copilotBufferExhaustionThreshold,
        }
      : { enabled: false },
    ...(reasoningEffort ?? env.copilotReasoningEffort
      ? { reasoningEffort: (reasoningEffort ?? env.copilotReasoningEffort) as ReasoningEffort }
      : {}),
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
    if (!createIfMissing) {
      return null;
    }

    return client.createSession({
      sessionId,
      ...config,
    });
  }
};

export const hydrateThreadDetailFromSession = async ({
  githubToken,
  ownerId,
  thread,
  approvalMode,
}: {
  githubToken?: string;
  ownerId: string;
  thread: ThreadSummary;
  approvalMode: CopilotApprovalMode;
}): Promise<ThreadDetail> => {
  if (!thread.copilotSessionId) {
    return {
      ...thread,
      messages: [],
    };
  }

  const session = await getOrCreateSession({
    sessionId: thread.copilotSessionId,
    githubToken,
    ownerId,
    threadId: thread.id,
    model: thread.model,
    reasoningEffort: thread.reasoningEffort,
    approvalMode,
    createIfMissing: false,
  });

  if (!session) {
    return {
      ...thread,
      messages: [],
    };
  }

  try {
    const events = await session.getMessages();
    const attachments = listThreadAttachmentReferences(ownerId, thread.id);
    const parsed = parseThreadMessages(events, attachments);
    return {
      ...thread,
      messages: parsed.messages,
      ...(parsed.pendingUserInputRequest ? { pendingUserInputRequest: parsed.pendingUserInputRequest } : {}),
    };
  } finally {
    await session.disconnect().catch(() => undefined);
  }
};

const now = () => new Date().toISOString();
