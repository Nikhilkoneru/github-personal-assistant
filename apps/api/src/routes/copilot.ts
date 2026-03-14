import type { CopilotApprovalMode } from '@github-personal-assistant/shared';

import { Router } from 'express';
import { z } from 'zod';

import { requireRequestSession } from '../lib/auth.js';
import { deleteCopilotSession, getCopilotOverview } from '../services/copilot.js';
import { getCopilotPreferences, setCopilotApprovalMode } from '../store/copilot-preferences-store.js';

const router = Router();

const filterSchema = z.object({
  cwd: z.string().trim().min(1).optional(),
  gitRoot: z.string().trim().min(1).optional(),
  repository: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
});

const preferenceSchema = z.object({
  approvalMode: z.enum(['approve-all', 'safer-defaults'] satisfies [CopilotApprovalMode, ...CopilotApprovalMode[]]),
});

router.get('/api/copilot/preferences', (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  response.json({ preferences: getCopilotPreferences() });
});

router.put('/api/copilot/preferences', (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  const parsed = preferenceSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  response.json({ preferences: setCopilotApprovalMode(parsed.data.approvalMode) });
});

router.get('/api/copilot/status', async (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  const parsed = filterSchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const overview = await getCopilotOverview(session.githubAccessToken, parsed.data);
    response.json(overview);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unable to load Copilot SDK status.',
    });
  }
});

router.delete('/api/copilot/sessions/:sessionId', async (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  const sessionId = request.params.sessionId?.trim();
  if (!sessionId) {
    response.status(400).json({ error: 'Session ID is required.' });
    return;
  }

  try {
    await deleteCopilotSession(session.githubAccessToken, sessionId);
    response.status(204).end();
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unable to delete Copilot SDK session.',
    });
  }
});

export default router;
