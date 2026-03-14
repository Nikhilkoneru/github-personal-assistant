import { Router } from 'express';
import type { ApiHealth } from '@github-personal-assistant/shared';

import {
  env,
  getApiOrigin,
  getCopilotAuthMode,
  isActiveAppAuthConfigured,
  isCopilotConfigured,
  isRagFlowConfigured,
  isRemoteAccessConfigured,
} from '../config';

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
    ragflowConfigured: isRagFlowConfigured(),
  };

  response.json(payload);
});

export default router;
