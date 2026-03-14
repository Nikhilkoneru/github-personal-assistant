import type {
  AttachmentSummary,
  ApiHealth,
  ChatStreamInput,
  ChatStreamEvent,
  CreateThreadInput,
  GitHubDeviceAuthPoll,
  GitHubDeviceAuthStart,
  ModelOption,
  ProjectDetail,
  ProjectSummary,
  ThreadDetail,
  ThreadSummary,
  UserSession,
} from '@github-personal-assistant/shared';

import { resolveApiUrl } from './api-config';

const SERVICE_ACCESS_TOKEN = process.env.EXPO_PUBLIC_SERVICE_ACCESS_TOKEN;

const buildUrl = async (path: string) => `${await resolveApiUrl()}${path}`;

const parseErrorMessage = (raw: string, status: number) => {
  if (!raw) {
    return `Request failed with status ${status}`;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    // Fall back to the raw response body.
  }

  return raw;
};

const parseNetworkError = (error: unknown) => {
  if (error instanceof Error) {
    if (error.message === 'Failed to fetch') {
      return 'The API is unavailable right now. Start the backend and try again.';
    }

    return error.message;
  }

  return 'The API is unavailable right now. Start the backend and try again.';
};

let unauthorizedHandler: (() => void | Promise<void>) | null = null;

export const registerUnauthorizedHandler = (handler: (() => void | Promise<void>) | null) => {
  unauthorizedHandler = handler;
};

const notifyUnauthorized = () => {
  void unauthorizedHandler?.();
};

const buildHeaders = (sessionToken?: string, extraHeaders?: HeadersInit) => ({
  ...(SERVICE_ACCESS_TOKEN ? { 'X-Service-Access-Token': SERVICE_ACCESS_TOKEN } : {}),
  ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  ...(extraHeaders ?? {}),
});

export const fetchJson = async <T>(path: string, options?: RequestInit, sessionToken?: string): Promise<T> => {
  let response: Response;

  try {
    response = await fetch(await buildUrl(path), {
      ...options,
      headers: buildHeaders(sessionToken, {
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      }),
    });
  } catch (error) {
    throw new Error(parseNetworkError(error));
  }

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 && sessionToken) {
      notifyUnauthorized();
    }
    throw new Error(parseErrorMessage(text, response.status));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};

export const getHealth = () => fetchJson<ApiHealth>('/api/health');

export const getProjects = (sessionToken?: string) =>
  fetchJson<{ projects: ProjectSummary[] }>('/api/projects', undefined, sessionToken);

export const getProject = (projectId: string, sessionToken?: string) =>
  fetchJson<{ project: ProjectDetail }>(`/api/projects/${projectId}`, undefined, sessionToken);

export const createProject = (payload: { name: string; description?: string }, sessionToken?: string) =>
  fetchJson<{ project: ProjectDetail }>(
    '/api/projects',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    sessionToken,
  );

export const getThreads = (sessionToken?: string, projectId?: string) =>
  fetchJson<{ threads: ThreadSummary[] }>(
    projectId ? `/api/threads?projectId=${encodeURIComponent(projectId)}` : '/api/threads',
    undefined,
    sessionToken,
  );

export const getThread = (threadId: string, sessionToken?: string) =>
  fetchJson<{ thread: ThreadDetail }>(`/api/threads/${threadId}`, undefined, sessionToken);

export const createThread = (payload: CreateThreadInput, sessionToken?: string) =>
  fetchJson<{ thread: ThreadSummary }>(
    '/api/threads',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    sessionToken,
  );

export const getModels = (sessionToken?: string) =>
  fetchJson<{ models: ModelOption[] }>('/api/models', undefined, sessionToken);

export const getSession = (sessionToken: string) =>
  fetchJson<{ session: UserSession | null }>('/api/auth/session', undefined, sessionToken);

export const logout = (sessionToken: string) =>
  fetchJson<void>(
    '/api/auth/logout',
    {
      method: 'POST',
    },
    sessionToken,
  );

export const startGitHubDeviceAuth = () =>
  fetchJson<GitHubDeviceAuthStart>('/api/auth/github/device/start', {
    method: 'POST',
  });

export const pollGitHubDeviceAuth = (flowId: string) =>
  fetchJson<GitHubDeviceAuthPoll>(`/api/auth/github/device/${encodeURIComponent(flowId)}`);

type UploadableAttachment = {
  uri: string;
  name: string;
  mimeType?: string;
  file?: File;
};

export const uploadAttachment = async (
  attachment: UploadableAttachment,
  sessionToken: string,
  options?: { threadId?: string; projectId?: string },
) => {
  const body = new FormData();

  if (attachment.file) {
    body.append('file', attachment.file, attachment.name);
  } else {
    body.append('file', {
      uri: attachment.uri,
      name: attachment.name,
      type: attachment.mimeType ?? 'application/octet-stream',
    } as unknown as Blob);
  }

  if (options?.threadId) {
    body.append('threadId', options.threadId);
  }

  if (options?.projectId) {
    body.append('projectId', options.projectId);
  }

  let response: Response;

  try {
    response = await fetch(await buildUrl('/api/attachments'), {
      method: 'POST',
      headers: buildHeaders(sessionToken),
      body,
    });
  } catch (error) {
    throw new Error(parseNetworkError(error));
  }

  if (!response.ok) {
    if (response.status === 401 && sessionToken) {
      notifyUnauthorized();
    }

    throw new Error(parseErrorMessage(await response.text(), response.status));
  }

  return response.json() as Promise<{ attachment: AttachmentSummary }>;
};

export const promoteAttachmentToKnowledge = (attachmentId: string, payload: { projectId: string }, sessionToken: string) =>
  fetchJson<{ attachment: AttachmentSummary }>(
    `/api/attachments/${attachmentId}/promote`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    sessionToken,
  );

export async function streamChat(
  input: ChatStreamInput,
  sessionToken: string | undefined,
  onEvent: (event: ChatStreamEvent) => void,
) {
  let response: Response;

  try {
    response = await fetch(await buildUrl('/api/chat/stream'), {
      method: 'POST',
      headers: buildHeaders(sessionToken, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new Error(parseNetworkError(error));
  }

  if (!response.ok) {
    if (response.status === 401 && sessionToken) {
      notifyUnauthorized();
    }
    throw new Error(parseErrorMessage(await response.text(), response.status));
  }

  if (!response.body || !('getReader' in response.body)) {
    throw new Error('This runtime does not support streaming fetch responses yet.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = rawEvent
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('data: '));

      if (dataLine) {
        onEvent(JSON.parse(dataLine.slice(6)) as ChatStreamEvent);
      }

      boundary = buffer.indexOf('\n\n');
    }
  }
}
