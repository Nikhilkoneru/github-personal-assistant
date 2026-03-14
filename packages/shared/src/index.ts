export type AppSessionUser = {
  id: number;
  login: string;
  name?: string | null;
  avatarUrl?: string;
};

export type UserSession = {
  sessionToken: string;
  user: AppSessionUser;
};

export type ApiHealth = {
  status: 'ok';
  copilotConfigured: boolean;
  authConfigured: boolean;
  apiOrigin: string;
  publicApiUrl?: string;
  tailscaleApiUrl?: string;
  remoteAccessMode: 'local' | 'tailscale' | 'public';
  remoteAccessConfigured: boolean;
  ragflowConfigured: boolean;
};

export type GitHubDeviceAuthStart = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: string;
  interval: number;
};

export type GitHubDeviceAuthPoll =
  | ({ status: 'pending' } & GitHubDeviceAuthStart)
  | { status: 'complete'; session: UserSession }
  | { status: 'denied' | 'expired'; error: string };

export type ModelOption = {
  id: string;
  name: string;
  source: 'sdk' | 'static';
  supportsReasoning?: boolean;
  premium?: boolean;
};

export type AttachmentKind = 'image' | 'document' | 'audio' | 'video' | 'other';
export type AttachmentScope = 'thread' | 'knowledge';
export type AttachmentKnowledgeStatus = 'none' | 'pending' | 'indexed' | 'failed';

export type AttachmentSummary = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  uploadedAt: string;
  scope: AttachmentScope;
  knowledgeStatus: AttachmentKnowledgeStatus;
};

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  defaultModel: string;
  updatedAt: string;
};

export type ProjectDetail = ProjectSummary & {
  instructions: string;
};

export type ChatRole = 'user' | 'assistant' | 'system' | 'error';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  attachments?: AttachmentSummary[];
};

export type ThreadSummary = {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  model: string;
  updatedAt: string;
  createdAt: string;
  copilotSessionId?: string;
  lastMessagePreview?: string;
};

export type ThreadDetail = ThreadSummary & {
  messages: ChatMessage[];
};

export type CreateThreadInput = {
  projectId?: string;
  title?: string;
  model?: string;
};

export type ChatStreamInput = {
  threadId: string;
  prompt: string;
  model?: string;
  attachments?: string[];
};

export type ChatStreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'chunk'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
