import { Router } from 'express';
import { z } from 'zod';

import type { ReasoningEffort } from '@github-personal-assistant/shared';

import { requireRequestSession } from '../lib/auth';
import { getCopilotPreferences } from '../store/copilot-preferences-store';
import { createThread, getThread, listThreads, updateThread } from '../store/thread-store';
import { hydrateThreadDetailFromSession } from '../services/copilot';

const router = Router();
const reasoningEfforts = ['low', 'medium', 'high', 'xhigh'] satisfies [ReasoningEffort, ...ReasoningEffort[]];

const createThreadSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: z.enum(reasoningEfforts).optional(),
});

const updateThreadSchema = z.object({
  projectId: z.string().trim().min(1).nullable().optional(),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: z.enum(reasoningEfforts).nullable().optional(),
});

router.get('/api/threads', (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  const projectId = typeof request.query.projectId === 'string' ? request.query.projectId : undefined;
  const threads = listThreads(String(session.user.id), projectId);
  response.json({ threads });
});

router.post('/api/threads', (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  const parsed = createThreadSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const thread = createThread(String(session.user.id), parsed.data);
  if (!thread) {
    response.status(404).json({ error: 'Project not found.' });
    return;
  }

  response.status(201).json({ thread });
});

router.get('/api/threads/:threadId', async (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  const ownerId = String(session.user.id);
  const thread = getThread(ownerId, request.params.threadId);
  if (!thread) {
    response.status(404).json({ error: 'Thread not found.' });
    return;
  }

  try {
    const hydrated = await hydrateThreadDetailFromSession({
      githubToken: session.githubAccessToken,
      ownerId,
      thread,
      approvalMode: getCopilotPreferences().approvalMode,
    });
    response.json({ thread: hydrated });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unable to load Copilot session history.',
    });
  }
});

router.patch('/api/threads/:threadId', (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  const parsed = updateThreadSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const thread = updateThread(String(session.user.id), request.params.threadId, parsed.data);
  if (!thread) {
    response.status(404).json({ error: 'Thread or project not found.' });
    return;
  }

  response.json({ thread });
});

export default router;
