import { Router } from 'express';
import { z } from 'zod';

import { requireRequestSession } from '../lib/auth.js';
import { createProject, getProject, listProjects } from '../store/project-store.js';

const router = Router();

const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(280).optional(),
});

const getOwnerId = (userId: string | number) => String(userId);

router.get('/api/projects', (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  const projects = listProjects(getOwnerId(session.user.id));
  response.json({ projects });
});

router.post('/api/projects', (request, response) => {
  const parsed = createProjectSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  const project = createProject(getOwnerId(session.user.id), parsed.data);
  response.status(201).json({ project });
});

router.get('/api/projects/:projectId', (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  const project = getProject(getOwnerId(session.user.id), request.params.projectId);

  if (!project) {
    response.status(404).json({ error: 'Project not found.' });
    return;
  }

  response.json({ project });
});

export default router;
