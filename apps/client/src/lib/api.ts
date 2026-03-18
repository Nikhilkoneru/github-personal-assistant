import type {
  AttachmentSummary,
  AuthCapabilities,
  ApiHealth,
  ChatStreamInput,
  ChatStreamEvent,
  ThreadMessageCursor,
  ThreadMessageSync,
  CopilotPreferences,
  CreateThreadInput,
  GitHubDeviceAuthPoll,
  GitHubDeviceAuthStart,
  ModelOption,
  ProjectSummary,
  ReasoningEffort,
  ThreadDetail,
  ThreadSummary,
  UserSession,
} from './types.js';

import { gzipSync } from 'fflate';

import { resolveApiUrl } from './api-config.js';

const buildUrl = async (path: string) => `${await resolveApiUrl()}${path}`;
const summarizeOrigin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

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

const parseNetworkError = (error: unknown, url: string) => {
  const origin = summarizeOrigin(url);
  const reachabilityHint =
    origin.includes('.ts.net')
      ? `The browser could not reach ${origin}. If you are using a Tailscale URL, this device/browser must be connected to the same tailnet.`
      : `The browser could not reach ${origin}. Check that the daemon is running and reachable from this device.`;

  if (error instanceof Error) {
    if (error.message === 'Failed to fetch' || error.message === 'Load failed' || /networkerror/i.test(error.message)) {
      return reachabilityHint;
    }

    return error.message;
  }

  return reachabilityHint;
};

let unauthorizedHandler: (() => void | Promise<void>) | null = null;

export const registerUnauthorizedHandler = (handler: (() => void | Promise<void>) | null) => {
  unauthorizedHandler = handler;
};

const notifyUnauthorized = () => {
  void unauthorizedHandler?.();
};

const buildHeaders = (sessionToken?: string, extraHeaders?: HeadersInit) => {
  const headers = new Headers(extraHeaders);
  if (sessionToken) {
    headers.set('Authorization', `Bearer ${sessionToken}`);
  }
  return headers;
};

export const fetchJson = async <T>(path: string, options?: RequestInit, sessionToken?: string): Promise<T> => {
  let response: Response;
  const url = await buildUrl(path);
  const headers = buildHeaders(sessionToken, options?.headers);

  if (options?.body !== undefined && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (error) {
    throw new Error(parseNetworkError(error, url));
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
export const getAuthCapabilities = () => fetchJson<AuthCapabilities>('/api/auth/capabilities');
export const getProjects = (sessionToken?: string) => fetchJson<{ projects: ProjectSummary[] }>('/api/projects', undefined, sessionToken);
export const getProject = (projectId: string, sessionToken?: string) =>
  fetchJson<{ project: ProjectSummary }>(`/api/projects/${projectId}`, undefined, sessionToken);
export const createProject = (payload: { name: string; description?: string; workspacePath?: string | null }, sessionToken?: string) =>
  fetchJson<{ project: ProjectSummary }>(
    '/api/projects',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    sessionToken,
  );
export const updateProject = (
  projectId: string,
  payload: { name?: string; description?: string; workspacePath?: string | null },
  sessionToken?: string,
) =>
  fetchJson<{ project: ProjectSummary }>(
    `/api/projects/${projectId}`,
    {
      method: 'PATCH',
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
export const getThread = (threadId: string, sessionToken?: string, cursor?: ThreadMessageCursor) => {
  const params = new URLSearchParams();
  if (cursor) {
    params.set('knownMessageCount', String(cursor.totalMessages));
    params.set('knownMessageDigest', cursor.digest);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return fetchJson<{ thread: ThreadDetail; messageSync: ThreadMessageSync }>(
    `/api/threads/${threadId}${suffix}`,
    undefined,
    sessionToken,
  );
};
export const createThread = (payload: CreateThreadInput, sessionToken?: string) =>
  fetchJson<{ thread: ThreadSummary }>(
    '/api/threads',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    sessionToken,
  );
export const updateThread = (
  threadId: string,
  payload: { projectId?: string | null; model?: string; reasoningEffort?: ReasoningEffort | null },
  sessionToken?: string,
) =>
  fetchJson<{ thread: ThreadSummary }>(
    `/api/threads/${threadId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
    sessionToken,
  );
export const getModels = (sessionToken?: string) => fetchJson<{ models: ModelOption[] }>('/api/models', undefined, sessionToken);
export const getCopilotPreferences = (sessionToken: string) =>
  fetchJson<{ preferences: CopilotPreferences }>('/api/copilot/preferences', undefined, sessionToken);
export const updateCopilotPreferences = (
  payload: { approvalMode?: CopilotPreferences['approvalMode']; generalChatWorkspacePath?: string | null },
  sessionToken: string,
) =>
  fetchJson<{ preferences: CopilotPreferences }>(
    '/api/copilot/preferences',
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
    sessionToken,
  );
export const getSession = (sessionToken: string) => fetchJson<{ session: UserSession | null }>('/api/auth/session', undefined, sessionToken);
export const bootstrapLocalSession = () => fetchJson<{ session: UserSession }>('/api/auth/local/session', { method: 'POST' });
export const logout = (sessionToken: string) =>
  fetchJson<void>(
    '/api/auth/logout',
    {
      method: 'POST',
    },
    sessionToken,
  );
export const startGitHubDeviceAuth = () => fetchJson<GitHubDeviceAuthStart>('/api/auth/github/device/start', { method: 'POST' });
export const pollGitHubDeviceAuth = (flowId: string) =>
  fetchJson<GitHubDeviceAuthPoll>(`/api/auth/github/device/${encodeURIComponent(flowId)}`);
export const getGitHubAuthorizeUrl = (redirectUri: string) =>
  fetchJson<{ authorizeUrl: string }>(`/api/auth/github/url?redirectUri=${encodeURIComponent(redirectUri)}`);

type UploadableAttachment = {
  name: string;
  mimeType?: string;
  file: File;
};

const MIN_COMPRESSIBLE_ATTACHMENT_BYTES = 64 * 1024;
const MIN_COMPRESSION_SAVINGS_BYTES = 1024;
const COMPRESSED_UPLOAD_MIME_TYPE = 'application/gzip';

const isCompressibleAttachmentType = (mimeType: string) => mimeType === 'application/pdf' || mimeType.startsWith('image/');

const prepareAttachmentUpload = async (attachment: UploadableAttachment) => {
  const originalName = attachment.name || attachment.file.name || 'attachment';
  const originalMimeType = attachment.mimeType?.trim() || attachment.file.type || 'application/octet-stream';

  if (!isCompressibleAttachmentType(originalMimeType) || attachment.file.size < MIN_COMPRESSIBLE_ATTACHMENT_BYTES) {
    return {
      file: attachment.file,
      fileName: originalName,
      originalName,
      originalMimeType,
    };
  }

  const sourceBytes = new Uint8Array(await attachment.file.arrayBuffer());
  const compressedBytes = gzipSync(sourceBytes, { level: 6 });
  if (compressedBytes.byteLength + MIN_COMPRESSION_SAVINGS_BYTES >= sourceBytes.byteLength) {
    return {
      file: attachment.file,
      fileName: originalName,
      originalName,
      originalMimeType,
    };
  }
  const uploadBytes = new Uint8Array(compressedBytes.byteLength);
  uploadBytes.set(compressedBytes);

  return {
    file: new Blob([uploadBytes], { type: COMPRESSED_UPLOAD_MIME_TYPE }),
    fileName: `${originalName}.gz`,
    originalName,
    originalMimeType,
    contentEncoding: 'gzip' as const,
  };
};

export const uploadAttachment = async (
  attachment: UploadableAttachment,
  sessionToken: string,
  options?: { threadId?: string },
) => {
  const body = new FormData();
  const url = await buildUrl('/api/attachments');
  const preparedUpload = await prepareAttachmentUpload(attachment);
  body.append('file', preparedUpload.file, preparedUpload.fileName);
  body.append('originalName', preparedUpload.originalName);
  body.append('originalMimeType', preparedUpload.originalMimeType);
  if (preparedUpload.contentEncoding) {
    body.append('contentEncoding', preparedUpload.contentEncoding);
  }

  if (options?.threadId) {
    body.append('threadId', options.threadId);
  }

  let response: Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(sessionToken),
      body,
    });
  } catch (error) {
    throw new Error(parseNetworkError(error, url));
  }

  if (!response.ok) {
    if (response.status === 401 && sessionToken) {
      notifyUnauthorized();
    }

    throw new Error(parseErrorMessage(await response.text(), response.status));
  }

  return response.json() as Promise<{ attachment: AttachmentSummary }>;
};

export const abortChat = (payload: { threadId: string }, sessionToken: string) =>
  fetchJson<{ aborted: boolean }>(
    '/api/chat/abort',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    sessionToken,
  );

export const respondToUserInput = (payload: { threadId: string; requestId: string; answer: string }, sessionToken: string) =>
  fetchJson<{ accepted: boolean }>(
    '/api/chat/user-input',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    sessionToken,
  );

export const respondToPermissionRequest = (payload: { threadId: string; requestId: string; optionId: string }, sessionToken: string) =>
  fetchJson<{ accepted: boolean }>(
    '/api/chat/permission',
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
  const url = await buildUrl('/api/chat/stream');

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(sessionToken, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new Error(parseNetworkError(error, url));
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
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim();

      if (dataLine) {
        onEvent(JSON.parse(dataLine) as ChatStreamEvent);
      }

      boundary = buffer.indexOf('\n\n');
    }
  }
}
