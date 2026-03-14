export type AppSessionUser = {
  id: string;
  login: string;
  name?: string | null;
  avatarUrl?: string;
};

export type AppAuthMode = 'local' | 'github-device' | 'github-oauth';
export type CopilotAuthMode = 'logged-in-user' | 'github-token' | 'cli-url' | 'unconfigured';

export type UserSession = {
  sessionToken: string;
  user: AppSessionUser;
};

export type AuthSignInCapabilities = {
  label: string;
  description: string;
  automatic: boolean;
  localBootstrap: boolean;
  deviceFlow: boolean;
  redirectFlow: boolean;
};

export type AuthCapabilities = {
  mode: AppAuthMode;
  supportedModes: AppAuthMode[];
  backendHandled: boolean;
  sessionRequired: boolean;
  serviceTokenRequired: boolean;
  authConfigured: boolean;
  version: string;
  copilotAuthMode: CopilotAuthMode;
  signIn: AuthSignInCapabilities;
};

export type ApiHealth = {
  status: 'ok';
  copilotConfigured: boolean;
  authConfigured: boolean;
  authMode: AppAuthMode;
  copilotAuthMode: CopilotAuthMode;
  apiOrigin: string;
  publicApiUrl?: string;
  tailscaleApiUrl?: string;
  remoteAccessMode: 'local' | 'tailscale' | 'public';
  remoteAccessConfigured: boolean;
  ragflowConfigured: boolean;
};

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type CopilotModelCapabilities = {
  supports: {
    vision: boolean;
    reasoningEffort: boolean;
  };
  limits: {
    maxPromptTokens?: number;
    maxContextWindowTokens: number;
    vision?: {
      supportedMediaTypes: string[];
      maxPromptImages: number;
      maxPromptImageSize: number;
    };
  };
};

export type CopilotModelPolicy = {
  state: 'enabled' | 'disabled' | 'unconfigured';
  terms: string;
};

export type CopilotModelBilling = {
  multiplier: number;
};

export type CopilotSessionContext = {
  cwd: string;
  gitRoot?: string;
  repository?: string;
  branch?: string;
};

export type CopilotSessionSummary = {
  sessionId: string;
  startTime: string;
  modifiedTime: string;
  summary?: string;
  isRemote: boolean;
  context?: CopilotSessionContext;
};

export type CopilotRuntimeStatus = {
  version: string;
  protocolVersion: number;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'error';
};

export type CopilotAuthStatus = {
  isAuthenticated: boolean;
  authType?: 'user' | 'env' | 'gh-cli' | 'hmac' | 'api-key' | 'token';
  host?: string;
  login?: string;
  statusMessage?: string;
};

export type CopilotStatusResponse = {
  status: CopilotRuntimeStatus;
  auth: CopilotAuthStatus;
  sessions: CopilotSessionSummary[];
  lastSessionId?: string;
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
  capabilities?: CopilotModelCapabilities;
  policy?: CopilotModelPolicy;
  billing?: CopilotModelBilling;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
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
