import { Router } from 'express';
import type { ApiHealth } from '@github-personal-assistant/shared';

import {
  env,
  getApiOrigin,
  getCopilotAuthMode,
  isActiveAppAuthConfigured,
  isCopilotConfigured,
  isRemoteAccessConfigured,
} from '../config.js';

const router = Router();

router.get('/api/health', (_request, response) => {
  const payload: ApiHealth = {
    status: 'ok',
    copilotConfigured: isCopilotConfigured(),
    authConfigured: isActiveAppAuthConfigured(),
    authMode: env.appAuthMode,
    copilotAuthMode: getCopilotAuthMode(),
    apiOrigin: getApiOrigin(),
    publicApiUrl: env.publicApiUrl,
    tailscaleApiUrl: env.tailscaleApiUrl,
    remoteAccessMode: env.remoteAccessMode,
    remoteAccessConfigured: isRemoteAccessConfigured(),
  };

  response.json(payload);
});

export default router;
