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

export type DaemonToolStatus = {
  found: boolean;
  path?: string;
  version?: string;
};

export type DaemonRuntimeInfo = {
  version: string;
  platform: string;
  arch: string;
  pid: number;
  startedAt: string;
  executablePath: string;
  configPath: string;
  configFileExists: boolean;
  logPath: string;
  dataPath: string;
  mediaPath: string;
  serviceManager: 'launchd' | 'systemd' | 'task-scheduler' | 'manual' | string;
  serviceName: string;
  serviceDefinitionPath: string;
  serviceInstalled: boolean;
  controlSurface: string;
  installHint: string;
  restartHint: string;
  statusHint: string;
  logsHint: string;
  updateHint: string;
  uiAccessUrl: string;
  uiAccessHint: string;
  copilot: DaemonToolStatus;
};

export type ApiHealth = {
  status: 'ok' | 'degraded';
  copilotConfigured: boolean;
  authConfigured: boolean;
  authMode: AppAuthMode;
  copilotAuthMode: CopilotAuthMode;
  apiOrigin: string;
  publicApiUrl?: string;
  tailscaleApiUrl?: string;
  remoteAccessMode: 'local' | 'tailscale' | 'public';
  remoteAccessConfigured: boolean;
  runtime?: DaemonRuntimeInfo;
};

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type CopilotApprovalMode = 'approve-all' | 'safer-defaults';

export type CopilotPreferences = {
  approvalMode: CopilotApprovalMode;
};

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

export type AttachmentSummary = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  uploadedAt: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
};

export type ProjectDetail = ProjectSummary;

export type ChatRole = 'user' | 'assistant' | 'system' | 'error';

export type ChatUsage = {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  duration?: number;
  initiator?: string;
};

export type ChatToolActivity = {
  id: string;
  toolName: string;
  kind?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  arguments?: string;
  result?: string;
  additionalContext?: string;
  locations?: string[];
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  suppressed?: boolean;
  error?: string;
};

export type ChatPermissionOption = {
  optionId: string;
  label: string;
  kind?: string;
};

export type ChatPermissionRequest = {
  requestId: string;
  sessionId: string;
  toolCallId?: string;
  toolName?: string;
  toolKind?: string;
  question: string;
  options: ChatPermissionOption[];
  createdAt: string;
};

export type ChatMessageMetadata = {
  sessionMessageId?: string;
  reasoning?: string;
  reasoningState?: 'streaming' | 'complete';
  usage?: ChatUsage;
  toolActivities?: ChatToolActivity[];
  phase?: string;
  planItems?: string[];
};

export type ChatUserInputRequest = {
  requestId: string;
  question: string;
  choices?: string[];
  allowFreeform: boolean;
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  attachments?: AttachmentSummary[];
  metadata?: ChatMessageMetadata;
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
  reasoningEffort?: ReasoningEffort;
};

export type ThreadDetail = ThreadSummary & {
  messages: ChatMessage[];
  pendingUserInputRequest?: ChatUserInputRequest;
  pendingPermissionRequests?: ChatPermissionRequest[];
};

export type CreateThreadInput = {
  projectId?: string;
  title?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
};

export type UpdateThreadInput = {
  projectId?: string | null;
  model?: string;
  reasoningEffort?: ReasoningEffort | null;
};

export type ChatStreamInput = {
  threadId: string;
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  attachments?: string[];
};

export type ChatStreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'chunk'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'reasoning'; content: string }
  | { type: 'status'; phase: string }
  | { type: 'plan'; items: string[] }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'tool_event'; activity: ChatToolActivity }
  | { type: 'user_input_request'; request: ChatUserInputRequest }
  | { type: 'user_input_cleared'; requestId: string }
  | { type: 'permission_request'; request: ChatPermissionRequest }
  | { type: 'permission_cleared'; requestId: string }
  | { type: 'aborted'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
