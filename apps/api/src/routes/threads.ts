import { Router } from 'express';
import { z } from 'zod';

import { requireRequestSession } from '../lib/auth';
import { createThread, getThreadDetail, listThreads } from '../store/thread-store';

const router = Router();

const createThreadSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).optional(),
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

router.get('/api/threads/:threadId', (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  const thread = getThreadDetail(String(session.user.id), request.params.threadId);
  if (!thread) {
    response.status(404).json({ error: 'Thread not found.' });
    return;
  }

  response.json({ thread });
});

export default router;
