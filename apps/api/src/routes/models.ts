import { Router } from 'express';

import { requireRequestSession } from '../lib/auth.js';
import { listModels } from '../services/copilot.js';

const router = Router();

router.get('/api/models', async (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  try {
    const models = await listModels(session.githubAccessToken);
    response.json({ models });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unable to load Copilot models.',
    });
  }
});

export default router;
