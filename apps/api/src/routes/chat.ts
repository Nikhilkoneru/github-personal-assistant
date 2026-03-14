import { Router, type Response } from 'express';
import { z } from 'zod';

import type { ChatStreamEvent, ChatToolActivity, ChatUserInputRequest, ReasoningEffort } from '@github-personal-assistant/shared';

import { requireRequestSession } from '../lib/auth';
import { getOrCreateSession } from '../services/copilot';
import { buildAttachmentPromptContext, getAttachmentInputs } from '../store/attachment-store';
import { getCopilotPreferences } from '../store/copilot-preferences-store';
import { getThread, renameThreadIfPlaceholder, updateThread, updateThreadPreview, updateThreadSession } from '../store/thread-store';

const router = Router();
const SEND_AND_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const reasoningEfforts = ['low', 'medium', 'high', 'xhigh'] satisfies [ReasoningEffort, ...ReasoningEffort[]];

const chatSchema = z.object({
  threadId: z.string().trim().min(1),
  prompt: z.string().trim().min(1).max(8000),
  model: z.string().trim().optional(),
  reasoningEffort: z.enum(reasoningEfforts).optional(),
  attachments: z.array(z.string().trim().min(1)).max(5).optional(),
});

const abortSchema = z.object({
  threadId: z.string().trim().min(1),
});

const userInputSchema = z.object({
  threadId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  answer: z.string().max(4000),
});

type SessionLike = {
  on: (eventName: string, listener: (event: unknown) => void) => () => void;
  sendAndWait: (input: {
    prompt: string;
    attachments?: Array<{ type: 'file'; path: string; displayName?: string }>;
  }, timeout?: number) => Promise<{ data?: { content?: string } } | undefined>;
  abort: () => Promise<void>;
  disconnect: () => Promise<void>;
};

type PendingUserInput = {
  request: ChatUserInputRequest;
  resolve: (value: { answer: string; wasFreeform: boolean }) => void;
  reject: (error?: unknown) => void;
};

type ActiveSessionEntry = {
  session: SessionLike | null;
  aborted: boolean;
  pendingUserInputs: Map<string, PendingUserInput>;
};

const activeSessions = new Map<string, ActiveSessionEntry>();
const pendingAborts = new Set<string>();

const flushResponse = (response: Response) => {
  const maybeFlush = (response as Response & { flush?: () => void }).flush;
  if (typeof maybeFlush === 'function') {
    maybeFlush.call(response);
  }
};

const writeEvent = (response: Response, payload: ChatStreamEvent) => {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  flushResponse(response);
};

const summarizeTitle = (prompt: string) => {
  const singleLine = prompt.replace(/\s+/g, ' ').trim();
  return singleLine.length > 42 ? `${singleLine.slice(0, 42)}...` : singleLine;
};

const asRecord = (value: unknown) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null);
const asString = (value: unknown) => (typeof value === 'string' ? value : undefined);

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

const writeToolActivity = (response: Response, activity: ChatToolActivity) => {
  writeEvent(response, { type: 'tool_event', activity });
};

router.post('/api/chat/abort', async (request, response) => {
  const parsed = abortSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const userSession = requireRequestSession(request, response);
  if (!userSession) {
    return;
  }

  const ownerId = String(userSession.user.id);
  const thread = getThread(ownerId, parsed.data.threadId);
  if (!thread) {
    response.status(404).json({ error: 'Thread not found.' });
    return;
  }

  const entry = activeSessions.get(thread.id);
  if (!entry) {
    pendingAborts.add(thread.id);
    response.json({ aborted: true });
    return;
  }

  entry.aborted = true;
  for (const pending of entry.pendingUserInputs.values()) {
    pending.reject(new Error('Response stopped.'));
  }
  entry.pendingUserInputs.clear();
  await entry.session?.abort().catch(() => undefined);
  response.json({ aborted: true });
});

router.post('/api/chat/user-input', (request, response) => {
  const parsed = userInputSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const userSession = requireRequestSession(request, response);
  if (!userSession) {
    return;
  }

  const ownerId = String(userSession.user.id);
  const thread = getThread(ownerId, parsed.data.threadId);
  if (!thread) {
    response.status(404).json({ error: 'Thread not found.' });
    return;
  }

  const entry = activeSessions.get(thread.id);
  const pending = entry?.pendingUserInputs.get(parsed.data.requestId);
  if (!entry || !pending) {
    response.status(404).json({ error: 'Input request not found.' });
    return;
  }

  entry.pendingUserInputs.delete(parsed.data.requestId);
  pending.resolve({
    answer: parsed.data.answer,
    wasFreeform: !pending.request.choices?.includes(parsed.data.answer),
  });
  response.json({ accepted: true });
});

router.post('/api/chat/stream', async (request, response) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const userSession = requireRequestSession(request, response);
  if (!userSession) {
    return;
  }

  const ownerId = String(userSession.user.id);
  const thread = getThread(ownerId, parsed.data.threadId);
  if (!thread) {
    response.status(404).json({ error: 'Thread not found.' });
    return;
  }

  const sessionId = thread.copilotSessionId ?? `thread-${thread.id}`;
  const approvalMode = getCopilotPreferences().approvalMode;
  const model = parsed.data.model ?? thread.model;
  const reasoningEffort = parsed.data.reasoningEffort ?? thread.reasoningEffort;

  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.socket?.setNoDelay(true);
  response.flushHeaders();

  writeEvent(response, { type: 'session', sessionId });

  let session: SessionLike | null = null;
  const activeEntry: ActiveSessionEntry = {
    session: null,
    aborted: false,
    pendingUserInputs: new Map(),
  };
  const unsubscribers: Array<() => void> = [];
  let streamedContent = '';

  try {
    const attachmentInputs = parsed.data.attachments?.length ? await getAttachmentInputs(ownerId, parsed.data.attachments) : [];
    if (parsed.data.attachments && !attachmentInputs) {
      writeEvent(response, { type: 'error', message: 'One or more attachments could not be found.' });
      response.end();
      return;
    }

    const attachmentPromptContext = parsed.data.attachments?.length
      ? await buildAttachmentPromptContext({
          ownerId,
          attachmentIds: parsed.data.attachments,
          query: parsed.data.prompt,
        })
      : '';
    if (parsed.data.attachments && attachmentPromptContext === null) {
      writeEvent(response, { type: 'error', message: 'One or more attachments could not be found.' });
      response.end();
      return;
    }

    const enrichedPrompt = [
      parsed.data.prompt,
      attachmentPromptContext
        ? ['Use the following locally extracted attachment context when it helps answer the latest request.', attachmentPromptContext].join('\n\n')
        : null,
    ]
      .filter((section): section is string => Boolean(section))
      .join('\n\n');

    renameThreadIfPlaceholder(thread.id, summarizeTitle(parsed.data.prompt));
    updateThread(ownerId, thread.id, { model, reasoningEffort: reasoningEffort ?? null });
    updateThreadSession(thread.id, sessionId);
    updateThreadPreview(thread.id, parsed.data.prompt);

    session = (await getOrCreateSession({
      sessionId,
      githubToken: userSession.githubAccessToken,
      ownerId,
      threadId: thread.id,
      model,
      reasoningEffort,
      approvalMode,
      onUserInputRequest: async (userInputRequest) => {
        writeEvent(response, { type: 'user_input_request', request: userInputRequest });
        return await new Promise<{ answer: string; wasFreeform: boolean }>((resolve, reject) => {
          activeEntry.pendingUserInputs.set(userInputRequest.requestId, {
            request: userInputRequest,
            resolve: (value) => {
              writeEvent(response, { type: 'user_input_cleared', requestId: userInputRequest.requestId });
              resolve(value);
            },
            reject,
          });
        });
      },
    })) as SessionLike | null;

    if (!session) {
      writeEvent(response, { type: 'error', message: 'Unable to restore the Copilot session.' });
      response.end();
      return;
    }

    activeEntry.session = session;
    activeSessions.set(thread.id, activeEntry);

    if (pendingAborts.has(thread.id)) {
      pendingAborts.delete(thread.id);
      activeEntry.aborted = true;
      writeEvent(response, { type: 'aborted', message: 'Response stopped.' });
      return;
    }

    unsubscribers.push(
      session.on('assistant.message_delta', (event: unknown) => {
        const delta = asString(asRecord(asRecord(event)?.data)?.deltaContent) ?? '';
        if (!delta) {
          return;
        }

        streamedContent += delta;
        writeEvent(response, { type: 'chunk', delta });
      }),
    );

    unsubscribers.push(
      session.on('assistant.message', (event: unknown) => {
        const content = asString(asRecord(asRecord(event)?.data)?.content) ?? '';
        if (!content) {
          return;
        }

        streamedContent = content;
        updateThreadPreview(thread.id, content);
      }),
    );

    unsubscribers.push(
      session.on('assistant.reasoning_delta', (event: unknown) => {
        const delta = asString(asRecord(asRecord(event)?.data)?.deltaContent) ?? '';
        if (delta) {
          writeEvent(response, { type: 'reasoning_delta', delta });
        }
      }),
    );

    unsubscribers.push(
      session.on('assistant.reasoning', (event: unknown) => {
        const content = asString(asRecord(asRecord(event)?.data)?.content) ?? '';
        if (content) {
          writeEvent(response, { type: 'reasoning', content });
        }
      }),
    );

    unsubscribers.push(
      session.on('assistant.usage', (event: unknown) => {
        const data = asRecord(asRecord(event)?.data);
        if (!data) {
          return;
        }

        const modelName = asString(data.model);
        if (!modelName) {
          return;
        }

        writeEvent(response, {
          type: 'usage',
          usage: {
            model: modelName,
            inputTokens: typeof data.inputTokens === 'number' ? data.inputTokens : undefined,
            outputTokens: typeof data.outputTokens === 'number' ? data.outputTokens : undefined,
            cacheReadTokens: typeof data.cacheReadTokens === 'number' ? data.cacheReadTokens : undefined,
            cacheWriteTokens: typeof data.cacheWriteTokens === 'number' ? data.cacheWriteTokens : undefined,
            cost: typeof data.cost === 'number' ? data.cost : undefined,
            duration: typeof data.duration === 'number' ? data.duration : undefined,
            initiator: asString(data.initiator),
          },
        });
      }),
    );

    unsubscribers.push(
      session.on('tool.execution_start', (event: unknown) => {
        const data = asRecord(asRecord(event)?.data);
        const toolCallId = asString(data?.toolCallId);
        const toolName = asString(data?.toolName);
        if (!toolCallId || !toolName) {
          return;
        }

        writeToolActivity(response, {
          id: toolCallId,
          toolName,
          status: 'running',
          startedAt: asString(asRecord(event)?.timestamp) ?? new Date().toISOString(),
          updatedAt: asString(asRecord(event)?.timestamp) ?? new Date().toISOString(),
          arguments: serializeUnknown(data?.arguments),
        });
      }),
    );

    unsubscribers.push(
      session.on('tool.execution_progress', (event: unknown) => {
        const data = asRecord(asRecord(event)?.data);
        const toolCallId = asString(data?.toolCallId);
        if (!toolCallId) {
          return;
        }

        writeToolActivity(response, {
          id: toolCallId,
          toolName: 'Tool',
          status: 'running',
          startedAt: asString(asRecord(event)?.timestamp) ?? new Date().toISOString(),
          updatedAt: asString(asRecord(event)?.timestamp) ?? new Date().toISOString(),
          additionalContext: asString(data?.progressMessage),
        });
      }),
    );

    unsubscribers.push(
      session.on('tool.execution_partial_result', (event: unknown) => {
        const data = asRecord(asRecord(event)?.data);
        const toolCallId = asString(data?.toolCallId);
        if (!toolCallId) {
          return;
        }

        writeToolActivity(response, {
          id: toolCallId,
          toolName: 'Tool',
          status: 'running',
          startedAt: asString(asRecord(event)?.timestamp) ?? new Date().toISOString(),
          updatedAt: asString(asRecord(event)?.timestamp) ?? new Date().toISOString(),
          result: asString(data?.partialOutput),
        });
      }),
    );

    unsubscribers.push(
      session.on('tool.execution_complete', (event: unknown) => {
        const data = asRecord(asRecord(event)?.data);
        const toolCallId = asString(data?.toolCallId);
        if (!toolCallId) {
          return;
        }

        const result = asRecord(data?.result);
        const error = asRecord(data?.error);
        writeToolActivity(response, {
          id: toolCallId,
          toolName: 'Tool',
          status: data?.success === true ? 'completed' : 'failed',
          startedAt: asString(asRecord(event)?.timestamp) ?? new Date().toISOString(),
          updatedAt: asString(asRecord(event)?.timestamp) ?? new Date().toISOString(),
          result: asString(result?.detailedContent) ?? asString(result?.content),
          error: asString(error?.message),
        });
      }),
    );

    await session.sendAndWait({ prompt: enrichedPrompt, attachments: attachmentInputs ?? [] }, SEND_AND_WAIT_TIMEOUT_MS);

    if (activeEntry.aborted) {
      writeEvent(response, { type: 'aborted', message: 'Response stopped.' });
      return;
    }

    if (!streamedContent.trim()) {
      updateThreadPreview(thread.id, parsed.data.prompt);
    }
    writeEvent(response, { type: 'done' });
  } catch (error) {
    const wasAborted = activeEntry.aborted;
    if (wasAborted) {
      writeEvent(response, { type: 'aborted', message: 'Response stopped.' });
      return;
    }

    const message = error instanceof Error ? error.message : 'Unknown streaming error.';
    writeEvent(response, { type: 'error', message });
  } finally {
    for (const pending of activeEntry.pendingUserInputs.values()) {
      pending.reject(new Error('Session closed.'));
    }
    activeEntry.pendingUserInputs.clear();
    activeSessions.delete(thread.id);
    pendingAborts.delete(thread.id);
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    await session?.disconnect().catch(() => undefined);
    response.end();
  }
});

export default router;
