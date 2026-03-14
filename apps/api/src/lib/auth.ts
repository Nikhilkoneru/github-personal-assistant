import type { Request, Response } from 'express';

import { env } from '../config';
import { getAppSession } from '../store/auth-store';

const extractBearerToken = (request: Request) => {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }

  const sessionToken = request.headers['x-session-token'];
  if (typeof sessionToken === 'string') {
    return sessionToken;
  }

  return undefined;
};

const extractServiceToken = (request: Request) => {
  const header = request.headers['x-service-access-token'];
  return typeof header === 'string' ? header : undefined;
};

export const requireServiceAccess = (request: Request, response: Response) => {
  if (!env.serviceAccessToken) {
    return true;
  }

  if (extractServiceToken(request) === env.serviceAccessToken) {
    return true;
  }

  response.status(401).json({ error: 'Missing or invalid service access token.' });
  return false;
};

export const getRequestSession = (request: Request) => getAppSession(extractBearerToken(request));

export const requireRequestSession = (request: Request, response: Response) => {
  if (!requireServiceAccess(request, response)) {
    return null;
  }

  const sessionToken = extractBearerToken(request);
  if (!sessionToken) {
    response.status(401).json({
      error: env.appAuthMode === 'local' ? 'Your local daemon session is missing. Start a new local session and try again.' : 'You must sign in to use this product.',
    });
    return null;
  }

  const session = getAppSession(sessionToken);
  if (!session) {
    response.status(401).json({ error: 'Your session expired. Please sign in again.' });
    return null;
  }

  return session;
};
