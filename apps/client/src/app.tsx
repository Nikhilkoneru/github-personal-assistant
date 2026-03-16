import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AttachmentSummary,
  ApiHealth,
  ChatMessage,
  ChatToolActivity,
  CopilotPreferences,
  ModelOption,
  ProjectSummary,
  ReasoningEffort,
  ThreadDetail,
  ThreadSummary,
} from '@github-personal-assistant/shared';

import { MessageBubble } from './components/message-bubble.js';
import {
  abortChat,
  createProject,
  createThread,
  getCopilotPreferences,
  getHealth,
  getModels,
  respondToUserInput,
  getProjects,
  getThread,
  getThreads,
  streamChat,
  updateThread,
  updateCopilotPreferences,
  uploadAttachment,
} from './lib/api.js';
import { clearApiUrlOverride, getApiUrlOverride, getDefaultApiUrl, setApiUrlOverride } from './lib/api-config.js';
import { useAuth } from './providers/auth-provider.js';

type LocalChat = ThreadDetail & {
  draftAttachments: AttachmentSummary[];
  hasLoadedMessages: boolean;
};

type WorkspaceGroup = {
  id: string | null;
  label: string;
  chats: LocalChat[];
  isInbox?: boolean;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type IOSNavigator = Navigator & {
  standalone?: boolean;
};

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const messageRoleRank: Record<ChatMessage['role'], number> = {
  system: 0,
  user: 1,
  assistant: 2,
  error: 2,
};
const sortMessages = (messages: ChatMessage[]) =>
  [...messages]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const byTime = left.message.createdAt.localeCompare(right.message.createdAt);
      if (byTime !== 0) {
        return byTime;
      }

      const byRole = messageRoleRank[left.message.role] - messageRoleRank[right.message.role];
      return byRole !== 0 ? byRole : left.index - right.index;
    })
    .map(({ message }) => message);
const createMessage = (role: ChatMessage['role'], content: string, attachments?: AttachmentSummary[]): ChatMessage => ({
  id: createId(),
  role,
  content,
  createdAt: new Date().toISOString(),
  ...(attachments && attachments.length > 0 ? { attachments } : {}),
});
const upsertToolActivity = (activities: ChatToolActivity[] | undefined, nextActivity: ChatToolActivity) => {
  const current = activities ?? [];
  const existingIndex = current.findIndex((activity) => activity.id === nextActivity.id);
  if (existingIndex >= 0) {
    return current.map((activity, index) => (index === existingIndex ? { ...activity, ...nextActivity } : activity));
  }
  return [...current, nextActivity];
};
const toLocalChatSummary = (thread: ThreadSummary): LocalChat => ({ ...thread, messages: [], draftAttachments: [], hasLoadedMessages: false });
const mergeThreadIntoLocal = (thread: ThreadSummary, existing?: LocalChat): LocalChat => ({
  ...thread,
  messages: existing?.messages ?? [],
  draftAttachments: existing?.draftAttachments ?? [],
  hasLoadedMessages: existing?.hasLoadedMessages ?? false,
  pendingUserInputRequest: existing?.pendingUserInputRequest,
});
const mergeThreadDetailIntoLocal = (thread: ThreadDetail, existing?: LocalChat): LocalChat => ({
  ...thread,
  messages: sortMessages(thread.messages),
  draftAttachments: existing?.draftAttachments ?? [],
  hasLoadedMessages: true,
  pendingUserInputRequest: thread.pendingUserInputRequest,
});
const summarizeTitle = (prompt: string) => (prompt.length > 42 ? `${prompt.slice(0, 42)}...` : prompt);

function SettingsIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.25" />
      <path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 0 1 0 2.8 2 2 0 0 1-2.8 0l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 0 1-4 0v-.2a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 0 1 0-4h.2a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2H9a1 1 0 0 0 .6-.9V4a2 2 0 0 1 4 0v.2a1 1 0 0 0 .7.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1V9c0 .4.4.7.9.7h.2a2 2 0 0 1 0 4h-.2a1 1 0 0 0-.9.7Z" />
    </svg>
  );
}

function InstallIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v11" />
      <path d="m8 10 4 4 4-4" />
      <path d="M4 17.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.4 11.2-8.5 8.5a6 6 0 1 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2.2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4Z" />
    </svg>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={className ? `icon-button ${className}` : 'icon-button'}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

export default function App() {
  const { authCapabilities, openPendingGitHubVerification, pendingDeviceAuth, session, signIn, signOut, isRestoring } = useAuth();
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [chats, setChats] = useState<LocalChat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creatingProject, setCreatingProject] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [streamingChatIds, setStreamingChatIds] = useState<Set<string>>(new Set());
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [connectionSettingsVisible, setConnectionSettingsVisible] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [apiUrlInput, setApiUrlInput] = useState(getDefaultApiUrl());
  const [savedApiUrlOverride, setSavedApiUrlOverride] = useState<string | null>(null);
  const [savingConnection, setSavingConnection] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [copilotPreferences, setCopilotPreferences] = useState<CopilotPreferences>({ approvalMode: 'approve-all' });
  const [savingApprovalMode, setSavingApprovalMode] = useState(false);
  const [savingThreadConfigId, setSavingThreadConfigId] = useState<string | null>(null);
  const [draggedChatId, setDraggedChatId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | 'inbox' | 'new-project' | null>(null);
  const [movingChatId, setMovingChatId] = useState<string | null>(null);
  const [respondingToUserInputId, setRespondingToUserInputId] = useState<string | null>(null);
  const [userInputDrafts, setUserInputDrafts] = useState<Record<string, string>>({});
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const selectedChatIdRef = useRef<string | null>(null);
  selectedChatIdRef.current = selectedChatId;

  const defaultModel = models[0]?.id ?? 'gpt-5-mini';
  const suggestedApiUrl = health?.tailscaleApiUrl ?? health?.publicApiUrl ?? health?.apiOrigin ?? null;
  const activeApiUrl = savedApiUrlOverride ?? suggestedApiUrl ?? getDefaultApiUrl();
  const remoteAccessLabel =
    health?.remoteAccessMode === 'tailscale' ? 'Tailscale' : health?.remoteAccessMode === 'public' ? 'Public URL' : 'Local only';
  const activeAuthLabel =
    authCapabilities?.mode === 'local'
      ? 'Local daemon'
      : authCapabilities?.mode === 'github-oauth'
        ? 'GitHub OAuth'
        : authCapabilities?.mode === 'github-device'
          ? 'GitHub device flow'
          : 'Negotiating';
  const authDescription =
    authCapabilities?.signIn.description ?? 'Connect this client to your personal assistant daemon and keep the full chat history on your own machine.';
  const authEyebrow =
    authCapabilities?.mode === 'local'
      ? 'Your daemon'
      : authCapabilities?.mode === 'github-device' || authCapabilities?.mode === 'github-oauth'
        ? 'Secure access'
        : 'Github Personal Assistant';
  const authHeading =
    authCapabilities?.mode === 'local'
      ? 'Continue to your chats.'
      : 'Bring your own daemon, keep your own history.';
  const authSupportingCopy =
    authCapabilities?.mode === 'local'
      ? 'Projects, threads, and attachments stay on your daemon. This browser can reconnect without a GitHub sign-in screen.'
      : authDescription;

  useEffect(() => {
    if (!session) {
      setProjects([]);
      setModels([]);
      setChats([]);
      setSelectedChatId(null);
      setDraft('');
    }
  }, [session]);

  const refreshConnectionState = useCallback(async () => {
    const storedOverride = await getApiUrlOverride();
    setSavedApiUrlOverride(storedOverride);
    setApiUrlInput(storedOverride ?? getDefaultApiUrl());
  }, []);

  useEffect(() => {
    void refreshConnectionState();
  }, [refreshConnectionState]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const updateStandalone = () => {
      const iosStandalone = Boolean((window.navigator as IOSNavigator).standalone);
      setIsStandalone(mediaQuery.matches || iosStandalone);
    };

    updateStandalone();
    mediaQuery.addEventListener('change', updateStandalone);
    window.addEventListener('appinstalled', updateStandalone);

    return () => {
      mediaQuery.removeEventListener('change', updateStandalone);
      window.removeEventListener('appinstalled', updateStandalone);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      const promptEvent = event as BeforeInstallPromptEvent;
      promptEvent.preventDefault();
      setInstallPromptEvent(promptEvent);
    };

    const handleInstalled = () => {
      setInstallPromptEvent(null);
      setIsStandalone(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt as EventListener);
    window.addEventListener('appinstalled', handleInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt as EventListener);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const updateOnlineStatus = () => setIsOnline(window.navigator.onLine);
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);

    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
    };
  }, []);

  const updateChat = useCallback((chatId: string, updater: (chat: LocalChat) => LocalChat) => {
    setChats((current) => current.map((chat) => (chat.id === chatId ? updater(chat) : chat)));
  }, []);

  const upsertThreadSummary = useCallback((thread: ThreadSummary) => {
    setChats((current) => {
      const existing = current.find((chat) => chat.id === thread.id);
      if (existing) {
        return current.map((chat) => (chat.id === thread.id ? mergeThreadIntoLocal(thread, chat) : chat));
      }
      return [toLocalChatSummary(thread), ...current];
    });
  }, []);

  const upsertThreadDetail = useCallback((thread: ThreadDetail) => {
    setChats((current) => {
      const existing = current.find((chat) => chat.id === thread.id);
      const next = mergeThreadDetailIntoLocal(thread, existing);
      if (existing) {
        return current.map((chat) => (chat.id === thread.id ? next : chat));
      }
      return [next, ...current];
    });
  }, []);

  const loadThreadDetail = useCallback(
    async (threadId: string) => {
      if (!session) {
        return null;
      }

      const payload = await getThread(threadId, session.sessionToken);
      upsertThreadDetail(payload.thread);
      return payload.thread;
    },
    [session, upsertThreadDetail],
  );

  const ensureInitialThread = useCallback(async () => {
    if (!session) {
      return null;
    }
    const payload = await createThread({}, session.sessionToken);
    upsertThreadSummary(payload.thread);
    setSelectedChatId(payload.thread.id);
    return loadThreadDetail(payload.thread.id);
  }, [loadThreadDetail, session, upsertThreadSummary]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      if (!session) {
        const healthPayload = await getHealth();
        setHealth(healthPayload);
        return;
      }

      const [healthPayload, projectsPayload, modelsPayload, threadsPayload, preferencesPayload] = await Promise.all([
        getHealth(),
        getProjects(session.sessionToken),
        getModels(session.sessionToken),
        getThreads(session.sessionToken),
        getCopilotPreferences(session.sessionToken),
      ]);

      setHealth(healthPayload);
      setProjects(projectsPayload.projects);
      setModels(modelsPayload.models);
      setCopilotPreferences(preferencesPayload.preferences);
      setChats((current) => {
        const existingById = new Map(current.map((chat) => [chat.id, chat]));
        return threadsPayload.threads.map((thread) => mergeThreadIntoLocal(thread, existingById.get(thread.id)));
      });

      if (threadsPayload.threads.length === 0) {
        await ensureInitialThread();
        return;
      }

      const nextSelectedChatId =
        (selectedChatIdRef.current && threadsPayload.threads.some((thread) => thread.id === selectedChatIdRef.current) ? selectedChatIdRef.current : undefined) ??
        threadsPayload.threads[0]?.id ??
        null;

      if (nextSelectedChatId) {
        setSelectedChatId(nextSelectedChatId);
        await loadThreadDetail(nextSelectedChatId);
      }
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Failed to load the assistant.';
      setError(message);
      if (/session expired|sign in/i.test(message)) {
        void signOut();
      }
    } finally {
      setLoading(false);
    }
  }, [ensureInitialThread, loadThreadDetail, session, signOut]);

  useEffect(() => {
    if (!isRestoring) {
      void load();
    }
  }, [isRestoring, load]);

  const selectedChat = useMemo(() => chats.find((chat) => chat.id === selectedChatId) ?? chats[0] ?? null, [chats, selectedChatId]);
  const orderedChats = useMemo(() => [...chats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [chats]);
  const workspaceGroups = useMemo<WorkspaceGroup[]>(
    () => [
      {
        id: null,
        label: 'Inbox',
        chats: orderedChats.filter((chat) => !chat.projectId),
        isInbox: true,
      },
      ...projects.map((project) => ({
        id: project.id,
        label: project.name,
        chats: orderedChats.filter((chat) => chat.projectId === project.id),
      })),
    ],
    [orderedChats, projects],
  );
  const activeModelId = selectedChat?.model ?? defaultModel;
  const selectedModel = useMemo(() => models.find((model) => model.id === activeModelId) ?? null, [activeModelId, models]);
  const selectedReasoningEfforts = selectedModel?.supportedReasoningEfforts ?? [];
  const activeReasoningEffort =
    selectedChat?.reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? selectedReasoningEfforts[0] ?? null;
  const headerMeta = selectedChat?.projectName ? `Project: ${selectedChat.projectName}` : '';

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' });
  }, [selectedChat?.id, selectedChat?.messages]);

  const openConnectionSettings = useCallback(() => {
    setError(null);
    void refreshConnectionState();
    setConnectionSettingsVisible(true);
  }, [refreshConnectionState]);

  const handleInstallApp = useCallback(async () => {
    if (installPromptEvent) {
      await installPromptEvent.prompt();
      const choice = await installPromptEvent.userChoice.catch(() => ({ outcome: 'dismissed' as const, platform: '' }));
      if (choice.outcome === 'accepted') {
        setInstallPromptEvent(null);
      }
      return;
    }

    setError('Use your browser menu and choose "Install app" or "Add to Home Screen" to install this PWA.');
  }, [installPromptEvent]);

  const handleSaveConnection = useCallback(async () => {
    setSavingConnection(true);
    setError(null);
    try {
      const normalizedUrl = apiUrlInput.trim().replace(/\/+$/, '');
      if (!normalizedUrl || normalizedUrl === getDefaultApiUrl()) {
        await clearApiUrlOverride();
      } else {
        await setApiUrlOverride(normalizedUrl);
      }
      await refreshConnectionState();
      setConnectionSettingsVisible(false);
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : 'Unable to save the API endpoint.');
    } finally {
      setSavingConnection(false);
    }
  }, [apiUrlInput, refreshConnectionState]);

  const handleResetConnection = useCallback(async () => {
    setSavingConnection(true);
    setError(null);
    try {
      await clearApiUrlOverride();
      await refreshConnectionState();
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : 'Unable to reset the API endpoint.');
    } finally {
      setSavingConnection(false);
    }
  }, [refreshConnectionState]);

  const handleAuthPress = useCallback(() => {
    setError(null);
    const action = pendingDeviceAuth ? openPendingGitHubVerification() : signIn();
    void action.catch((authError) => {
      setError(authError instanceof Error ? authError.message : 'Unable to complete sign-in.');
    });
  }, [openPendingGitHubVerification, pendingDeviceAuth, signIn]);

  const handleApprovalModeChange = useCallback(
    async (approvalMode: CopilotPreferences['approvalMode']) => {
      if (!session) {
        return;
      }

      setSavingApprovalMode(true);
      setError(null);
      try {
        const payload = await updateCopilotPreferences({ approvalMode }, session.sessionToken);
        setCopilotPreferences(payload.preferences);
      } catch (settingsError) {
        setError(settingsError instanceof Error ? settingsError.message : 'Unable to update tool approvals.');
      } finally {
        setSavingApprovalMode(false);
      }
    },
    [session],
  );

  const handleThreadConfigChange = useCallback(
    async (threadId: string, payload: { model?: string; reasoningEffort?: ReasoningEffort | null }) => {
      if (!session) {
        return;
      }

      setSavingThreadConfigId(threadId);
      setError(null);
      try {
        const response = await updateThread(threadId, payload, session.sessionToken);
        upsertThreadSummary(response.thread);
        if (selectedChatId === threadId) {
          await loadThreadDetail(threadId);
        }
      } catch (threadConfigError) {
        setError(threadConfigError instanceof Error ? threadConfigError.message : 'Unable to update chat settings.');
      } finally {
        setSavingThreadConfigId((current) => (current === threadId ? null : current));
      }
    },
    [loadThreadDetail, selectedChatId, session, upsertThreadSummary],
  );

  const handleRespondToPendingInput = useCallback(
    async (requestId: string, answer: string) => {
      if (!session || !selectedChat) {
        return;
      }

      setRespondingToUserInputId(requestId);
      setError(null);
      try {
        await respondToUserInput({ threadId: selectedChat.id, requestId, answer }, session.sessionToken);
        setUserInputDrafts((current) => {
          const next = { ...current };
          delete next[requestId];
          return next;
        });
        updateChat(selectedChat.id, (chat) =>
          chat.pendingUserInputRequest?.requestId === requestId ? { ...chat, pendingUserInputRequest: undefined } : chat,
        );
      } catch (userInputError) {
        setError(userInputError instanceof Error ? userInputError.message : 'Unable to send your answer.');
      } finally {
        setRespondingToUserInputId((current) => (current === requestId ? null : current));
      }
    },
    [selectedChat, session, updateChat],
  );

  const handleCreateChat = useCallback(async (projectId?: string | null) => {
    if (!session) return;
    setError(null);
    try {
      const payload = await createThread(projectId ? { projectId } : {}, session.sessionToken);
      upsertThreadSummary(payload.thread);
      setSelectedChatId(payload.thread.id);
      await loadThreadDetail(payload.thread.id);
      setDraft('');
      setSidebarOpen(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create chat.');
    }
  }, [loadThreadDetail, session, upsertThreadSummary]);

  const handleMoveChat = useCallback(
    async (chatId: string, projectId?: string | null) => {
      if (!session) {
        return;
      }

      const existingChat = chats.find((chat) => chat.id === chatId);
      const normalizedProjectId = projectId ?? null;
      if ((existingChat?.projectId ?? null) === normalizedProjectId) {
        setDraggedChatId(null);
        setDragOverGroupId(null);
        return;
      }

      setMovingChatId(chatId);
      setError(null);
      try {
        const payload = await updateThread(chatId, { projectId: normalizedProjectId }, session.sessionToken);
        upsertThreadSummary(payload.thread);
        if (selectedChatId === chatId) {
          await loadThreadDetail(chatId);
        }
      } catch (moveError) {
        setError(moveError instanceof Error ? moveError.message : 'Unable to move chat.');
      } finally {
        setMovingChatId(null);
        setDraggedChatId(null);
        setDragOverGroupId(null);
      }
    },
    [chats, loadThreadDetail, selectedChatId, session, upsertThreadSummary],
  );

  const handleCreateProject = useCallback(async (chatIdToMove?: string | null) => {
    if (!session || !newProjectName.trim()) return;
    setCreatingProject(true);
    setError(null);
    try {
      const payload = await createProject({ name: newProjectName.trim() }, session.sessionToken);
      setProjects((current) => [payload.project, ...current]);
      if (chatIdToMove) {
        const moved = await updateThread(chatIdToMove, { projectId: payload.project.id }, session.sessionToken);
        upsertThreadSummary(moved.thread);
        if (selectedChatId === chatIdToMove) {
          await loadThreadDetail(chatIdToMove);
        }
      }
      setNewProjectName('');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create project.');
    } finally {
      setCreatingProject(false);
      setDraggedChatId(null);
      setDragOverGroupId(null);
    }
  }, [loadThreadDetail, newProjectName, selectedChatId, session, upsertThreadSummary]);

  const handleSelectChat = useCallback(
    async (chatId: string) => {
      setSelectedChatId(chatId);
      setSidebarOpen(false);
      const chat = chats.find((item) => item.id === chatId);
      if (chat?.hasLoadedMessages) {
        return;
      }
      try {
        await loadThreadDetail(chatId);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load that chat.');
      }
    },
    [chats, loadThreadDetail],
  );

  const handleChatDragStart = useCallback((chatId: string) => {
    setDraggedChatId(chatId);
  }, []);

  const handleChatDragEnd = useCallback(() => {
    setDraggedChatId(null);
    setDragOverGroupId(null);
  }, []);

  const handleWorkspaceDragOver = useCallback(
    (event: React.DragEvent, groupId: string | 'inbox' | 'new-project') => {
      event.preventDefault();
      if (!draggedChatId) {
        return;
      }
      setDragOverGroupId(groupId);
    },
    [draggedChatId],
  );

  const handleWorkspaceDrop = useCallback(
    async (event: React.DragEvent, projectId?: string | null) => {
      event.preventDefault();
      if (!draggedChatId) {
        return;
      }
      await handleMoveChat(draggedChatId, projectId ?? null);
    },
    [draggedChatId, handleMoveChat],
  );

  const handleCreateProjectDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      if (!draggedChatId || !newProjectName.trim()) {
        if (!newProjectName.trim()) {
          setError('Name the project before dropping a chat here.');
        }
        return;
      }
      await handleCreateProject(draggedChatId);
    },
    [draggedChatId, handleCreateProject, newProjectName],
  );

  const handleChooseFiles = useCallback(() => fileInputRef.current?.click(), []);

  const handleFilesSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!session || !selectedChat || uploadingAttachment) {
        event.target.value = '';
        return;
      }

      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      if (files.length === 0) {
        return;
      }

      setUploadingAttachment(true);
      setError(null);
      try {
        const remainingSlots = Math.max(0, 5 - selectedChat.draftAttachments.length);
        if (remainingSlots === 0) {
          setError('You can attach up to 5 files per message.');
          return;
        }

        const uploadedAttachments: AttachmentSummary[] = [];
        for (const file of files.slice(0, remainingSlots)) {
          const payload = await uploadAttachment(
            { file, name: file.name, mimeType: file.type || 'application/octet-stream' },
            session.sessionToken,
            { threadId: selectedChat.id },
          );
          uploadedAttachments.push(payload.attachment);
        }

        if (uploadedAttachments.length > 0) {
          updateChat(selectedChat.id, (chat) => ({ ...chat, draftAttachments: [...chat.draftAttachments, ...uploadedAttachments] }));
        }
      } catch (attachmentError) {
        setError(attachmentError instanceof Error ? attachmentError.message : 'Unable to attach file.');
      } finally {
        setUploadingAttachment(false);
      }
    },
    [selectedChat, session, updateChat, uploadingAttachment],
  );

  const handleRemoveAttachment = useCallback(
    (attachmentId: string) => {
      if (!selectedChat) return;
      updateChat(selectedChat.id, (chat) => ({
        ...chat,
        draftAttachments: chat.draftAttachments.filter((attachment) => attachment.id !== attachmentId),
      }));
    },
    [selectedChat, updateChat],
  );

  const handleSend = useCallback(async () => {
    if (!session || !selectedChat || !draft.trim() || streamingChatIds.has(selectedChat.id)) {
      return;
    }

    const prompt = draft.trim();
    let assistantMessageId = createId();
    const chatId = selectedChat.id;
    const model = selectedChat.model || defaultModel;
    const reasoningEffort = selectedChat.reasoningEffort;
    const messageAttachments = selectedChat.draftAttachments;
    let pendingDelta = '';
    let pendingReasoningDelta = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let splitAssistantMessageOnNextText = false;

    const ensureStreamingAssistantMessage = () => {
      if (!splitAssistantMessageOnNextText) {
        return;
      }

      assistantMessageId = createId();
      splitAssistantMessageOnNextText = false;
      updateChat(chatId, (chat) => ({
        ...chat,
        updatedAt: new Date().toISOString(),
        messages: sortMessages([
          ...chat.messages,
          { id: assistantMessageId, role: 'assistant', content: '', createdAt: new Date().toISOString(), metadata: {} },
        ]),
      }));
    };

    const flushPendingDelta = () => {
      if (!pendingDelta && !pendingReasoningDelta) {
        return;
      }
      ensureStreamingAssistantMessage();
      const nextDelta = pendingDelta;
      const nextReasoningDelta = pendingReasoningDelta;
      pendingDelta = '';
      pendingReasoningDelta = '';
      updateChat(chatId, (chat) => ({
        ...chat,
        updatedAt: new Date().toISOString(),
        messages: sortMessages(
          chat.messages.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  content: `${message.content}${nextDelta}`,
                  metadata: nextReasoningDelta
                    ? {
                        ...(message.metadata ?? {}),
                        reasoning: `${message.metadata?.reasoning ?? ''}${nextReasoningDelta}`,
                        reasoningState: 'streaming',
                      }
                    : message.metadata,
                }
              : message,
          ),
        ),
      }));
    };

    const scheduleFlush = () => {
      if (flushTimer !== null) {
        return;
      }
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPendingDelta();
      }, 16);
    };

    setDraft('');
    setError(null);
    setStreamingChatIds((prev) => new Set(prev).add(chatId));
    updateChat(chatId, (chat) => ({
      ...chat,
      title: chat.title === 'New chat' ? summarizeTitle(prompt) : chat.title,
      model,
      reasoningEffort,
      updatedAt: new Date().toISOString(),
      draftAttachments: [],
      pendingUserInputRequest: undefined,
      messages: sortMessages([
        ...chat.messages,
        createMessage('user', prompt, messageAttachments),
        { id: assistantMessageId, role: 'assistant', content: '', createdAt: new Date().toISOString(), metadata: {} },
      ]),
      hasLoadedMessages: true,
    }));

    try {
      await streamChat(
        {
          threadId: chatId,
          prompt,
          model,
          reasoningEffort,
          attachments: messageAttachments.map((attachment) => attachment.id),
        },
        session.sessionToken,
        (event) => {
          if (event.type === 'session') {
            updateChat(chatId, (chat) => ({ ...chat, copilotSessionId: event.sessionId }));
            return;
          }
          if (event.type === 'chunk') {
            pendingDelta += event.delta;
            scheduleFlush();
            return;
          }
          if (event.type === 'reasoning_delta') {
            pendingReasoningDelta += event.delta;
            scheduleFlush();
            return;
          }
          if (event.type === 'reasoning') {
            if (flushTimer !== null) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            flushPendingDelta();
            ensureStreamingAssistantMessage();
            updateChat(chatId, (chat) => ({
              ...chat,
              updatedAt: new Date().toISOString(),
              messages: sortMessages(
                chat.messages.map((message) =>
                  message.id === assistantMessageId
                    ? {
                        ...message,
                        metadata: {
                          ...(message.metadata ?? {}),
                          reasoning: event.content,
                          reasoningState: 'complete',
                        },
                      }
                    : message,
                ),
              ),
            }));
            return;
          }
          if (event.type === 'usage') {
            updateChat(chatId, (chat) => ({
              ...chat,
              messages: sortMessages(
                chat.messages.map((message) =>
                  message.id === assistantMessageId
                    ? {
                        ...message,
                        metadata: {
                          ...(message.metadata ?? {}),
                          usage: event.usage,
                        },
                      }
                    : message,
                ),
              ),
            }));
            return;
          }
          if (event.type === 'tool_event') {
            if (flushTimer !== null) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            flushPendingDelta();
            updateChat(chatId, (chat) => ({
              ...chat,
              messages: sortMessages(
                chat.messages.map((message) =>
                  message.id === assistantMessageId
                    ? {
                        ...message,
                        metadata: {
                          ...(message.metadata ?? {}),
                          toolActivities: upsertToolActivity(message.metadata?.toolActivities, event.activity),
                        },
                      }
                    : message,
                ),
              ),
            }));
            splitAssistantMessageOnNextText = true;
            return;
          }
          if (event.type === 'user_input_request') {
            updateChat(chatId, (chat) => ({
              ...chat,
              pendingUserInputRequest: event.request,
            }));
            return;
          }
          if (event.type === 'user_input_cleared') {
            updateChat(chatId, (chat) => ({
              ...chat,
              pendingUserInputRequest:
                chat.pendingUserInputRequest?.requestId === event.requestId ? undefined : chat.pendingUserInputRequest,
            }));
            return;
          }
          if (event.type === 'error') {
            if (flushTimer !== null) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            flushPendingDelta();
            updateChat(chatId, (chat) => ({
              ...chat,
              updatedAt: new Date().toISOString(),
              pendingUserInputRequest: undefined,
              messages: sortMessages(
                chat.messages.map((message) =>
                  message.id === assistantMessageId ? { ...message, role: 'error', content: event.message } : message,
                ),
              ),
            }));
            setError(event.message);
            return;
          }
          if (event.type === 'aborted') {
            if (flushTimer !== null) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            flushPendingDelta();
            updateChat(chatId, (chat) => {
              const assistantMessage = chat.messages.find((message) => message.id === assistantMessageId);
              const hasContent = Boolean(assistantMessage?.content.trim());
              return {
                ...chat,
                updatedAt: new Date().toISOString(),
                pendingUserInputRequest: undefined,
                messages: sortMessages(
                  chat.messages.map((message) =>
                    message.id === assistantMessageId
                      ? hasContent
                        ? message
                        : { ...message, role: 'error', content: event.message }
                      : message,
                  ),
                ),
              };
            });
            return;
          }
        },
      );
      await loadThreadDetail(chatId);
    } catch (sendError) {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushPendingDelta();
      const message = sendError instanceof Error ? sendError.message : 'Unable to send message.';
      updateChat(chatId, (chat) => ({
        ...chat,
        updatedAt: new Date().toISOString(),
        pendingUserInputRequest: undefined,
        messages: sortMessages(
          chat.messages.map((messageItem) =>
            messageItem.id === assistantMessageId ? { ...messageItem, role: 'error', content: message } : messageItem,
          ),
        ),
      }));
      setError(message);
      if (/session expired|sign in/i.test(message)) {
        void signOut();
      }
    } finally {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }
      flushPendingDelta();
      setStreamingChatIds((prev) => { const next = new Set(prev); next.delete(chatId); return next; });
    }
  }, [defaultModel, draft, loadThreadDetail, selectedChat, session, signOut, streamingChatIds, updateChat]);

  const handleAbortStreaming = useCallback(async () => {
    if (!session || !selectedChat || !streamingChatIds.has(selectedChat.id)) {
      return;
    }

    setError(null);
    try {
      await abortChat({ threadId: selectedChat.id }, session.sessionToken);
    } catch (abortError) {
      setError(abortError instanceof Error ? abortError.message : 'Unable to stop the current response.');
    }
  }, [selectedChat, session, streamingChatIds]);

  const connectionModal = connectionSettingsVisible ? (
    <div className="modal-backdrop" onClick={() => setConnectionSettingsVisible(false)}>
      <div className="sheet-card narrow" onClick={(event) => event.stopPropagation()}>
        <h2 className="modal-title">Connection settings</h2>
        <p className="modal-copy">Point this frontend at your own daemon service. For hosted frontends, a Tailscale HTTPS URL works best.</p>
        <label className="modal-label" htmlFor="daemon-url">Daemon URL</label>
        <input id="daemon-url" className="input" value={apiUrlInput} onChange={(event) => setApiUrlInput(event.target.value)} />
        <div className="helper-text">Default: {getDefaultApiUrl()}</div>
        <div className="helper-text">Tailscale example: https://your-mac.tailnet.ts.net</div>
        <div className="helper-text">If you use a `.ts.net` URL, this browser device also needs to be connected to your Tailscale tailnet.</div>
        {suggestedApiUrl ? <div className="helper-text">Suggested by daemon: {suggestedApiUrl}</div> : null}
        {savedApiUrlOverride ? <div className="helper-text">Saved override active</div> : null}
        <div className="modal-actions">
          {suggestedApiUrl ? <button className="ghost-button" onClick={() => setApiUrlInput(suggestedApiUrl)}>Use suggested URL</button> : null}
          <button className="ghost-button" onClick={() => setConnectionSettingsVisible(false)} disabled={savingConnection}>Cancel</button>
          <button className="ghost-button" onClick={() => void handleResetConnection()} disabled={savingConnection}>Use default</button>
          <button className="button" onClick={() => void handleSaveConnection()} disabled={savingConnection}>{savingConnection ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  ) : null;

  const approvalModeDescription =
    copilotPreferences.approvalMode === 'approve-all'
      ? 'Shell, write, and other Copilot tool requests run without extra blocking.'
      : 'Read-style tools stay available, while shell and write actions are denied by default.';
  const daemonRuntime = health?.runtime;
  const daemonVersionLabel = daemonRuntime ? `v${daemonRuntime.version}` : 'Unknown';
  const daemonServiceLabel = daemonRuntime
    ? `${daemonRuntime.serviceManager}${daemonRuntime.serviceInstalled ? ' (auto-start on login)' : ' (manual launch)'}`
    : 'Manual';
  const copilotCliLabel = daemonRuntime?.copilot.found
    ? daemonRuntime.copilot.version ?? daemonRuntime.copilot.path ?? 'Installed'
    : 'Not found';
  const isSelectedChatStreaming = Boolean(selectedChat && streamingChatIds.has(selectedChat.id));

  // Auto-grow composer textarea
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [draft]);

  const handleComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (isSelectedChatStreaming) {
          void handleAbortStreaming();
        } else if (draft.trim() && !isSelectedChatStreaming) {
          void handleSend();
        }
      }
    },
    [draft, handleAbortStreaming, handleSend, isSelectedChatStreaming],
  );

  const settingsModal = settingsVisible ? (
    <div className="modal-backdrop" onClick={() => setSettingsVisible(false)}>
      <div className="modal-card narrow" onClick={(event) => event.stopPropagation()}>
        <h2 className="modal-title">Settings</h2>
          <p className="modal-copy">Signed in as @{session?.user.login}</p>
          <div className="status-grid">
            <div className="status-item"><div className="status-label">Daemon</div><div className="status-value">{activeApiUrl}</div></div>
            <div className="status-item"><div className="status-label">Remote access</div><div className="status-value">{remoteAccessLabel}</div></div>
            <div className="status-item"><div className="status-label">Auth</div><div className="status-value">{health?.authConfigured ? activeAuthLabel : 'Not configured'}</div></div>
            <div className="status-item"><div className="status-label">Install</div><div className="status-value">{isStandalone ? 'Installed' : installPromptEvent ? 'Ready to install' : 'Browser install available'}</div></div>
            <div className="status-item"><div className="status-label">Connectivity</div><div className="status-value"><span className="status-inline"><span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />{isOnline ? 'Online' : 'Offline'}</span></div></div>
          </div>
        <div className="settings-block">
          <label className="modal-label" htmlFor="approval-mode">Tool approvals</label>
          <select
            id="approval-mode"
            className="select"
            value={copilotPreferences.approvalMode}
            onChange={(event) => void handleApprovalModeChange(event.target.value as CopilotPreferences['approvalMode'])}
            disabled={savingApprovalMode}
          >
            <option value="approve-all">Approve all</option>
            <option value="safer-defaults">Safer defaults</option>
          </select>
          <div className="helper-text">{savingApprovalMode ? 'Saving approval mode…' : approvalModeDescription}</div>
        </div>
        {daemonRuntime ? (
          <div className="settings-block">
            <div className="status-grid">
              <div className="status-item"><div className="status-label">Version</div><div className="status-value">{daemonVersionLabel}</div></div>
              <div className="status-item"><div className="status-label">Lifecycle</div><div className="status-value">{daemonServiceLabel}</div></div>
              <div className="status-item"><div className="status-label">Copilot CLI</div><div className="status-value">{copilotCliLabel}</div></div>
            </div>
            <div className="helper-text">Config: {daemonRuntime.configPath}</div>
            <div className="helper-text">Logs: {daemonRuntime.logPath}</div>
            <div className="helper-text">Restart: <code>{daemonRuntime.restartHint}</code></div>
            <div className="helper-text">Status: <code>{daemonRuntime.statusHint}</code></div>
            <div className="helper-text">Update: {daemonRuntime.updateHint}</div>
            <div className="helper-text">Deploy UI: <code>{daemonRuntime.uiDeployHint}</code></div>
          </div>
        ) : null}
        {!isStandalone ? <div className="install-note">On iPhone or iPad, open the browser share menu and choose <strong>Add to Home Screen</strong>.</div> : null}
        <div className="modal-actions">
          {!isStandalone ? <button className="ghost-button install-cta" onClick={() => void handleInstallApp()}><InstallIcon />Install app</button> : null}
          <button className="ghost-button" onClick={() => { setSettingsVisible(false); openConnectionSettings(); }}>Connection</button>
          <button className="ghost-button" onClick={() => setSettingsVisible(false)}>Close</button>
          <button className="danger-button" onClick={() => { setSettingsVisible(false); void signOut({ manual: true }); }}>
            {authCapabilities?.mode === 'local' ? 'Reset local session' : 'Sign out'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (isRestoring) {
    return <div className="auth-screen"><div className="auth-card"><div className="eyebrow">Loading</div><h1>Restoring your session…</h1></div></div>;
  }

  if (!session) {
    return (
      <>
        <div className="auth-screen">
          <section className="auth-card">
            <div className="eyebrow">{authEyebrow}</div>
            <h1>{authHeading}</h1>
            <p className="muted">{authSupportingCopy}</p>

            <div className="status-card">
              <div className="status-grid">
                <div className="status-item"><div className="status-label">Daemon endpoint</div><div className="status-value">{activeApiUrl}</div></div>
                <div className="status-item"><div className="status-label">Remote access</div><div className="status-value">{remoteAccessLabel}</div></div>
                <div className="status-item"><div className="status-label">Auth mode</div><div className="status-value">{activeAuthLabel}</div></div>
                <div className="status-item"><div className="status-label">Install</div><div className="status-value">{isStandalone ? 'Installed' : installPromptEvent ? 'Ready to install' : 'Use browser install'}</div></div>
                <div className="status-item"><div className="status-label">Connectivity</div><div className="status-value"><span className="status-inline"><span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />{isOnline ? 'Online' : 'Offline'}</span></div></div>
              </div>
            </div>

            {pendingDeviceAuth && authCapabilities?.mode === 'github-device' ? (
              <div className="device-auth-card">
                <div className="status-label">GitHub device sign-in</div>
                <div className="device-auth-code">{pendingDeviceAuth.userCode}</div>
                <div className="device-auth-body">Open GitHub's verification page, enter the code, and this page will keep polling until sign-in completes.</div>
                <a href={pendingDeviceAuth.verificationUriComplete ?? pendingDeviceAuth.verificationUri} target="_blank" rel="noreferrer" className="helper-text">
                  {pendingDeviceAuth.verificationUri}
                </a>
              </div>
            ) : null}

            {error ? <div className="error-banner">{error}</div> : null}
            <div className="modal-actions">
              <button className="button" onClick={handleAuthPress}>
                {pendingDeviceAuth && authCapabilities?.mode === 'github-device'
                  ? 'Open verification page'
                  : authCapabilities?.signIn.label ?? 'Continue'}
              </button>
              <button className="ghost-button" onClick={openConnectionSettings}>Connection settings</button>
            </div>
          </section>
        </div>
        {connectionModal}
      </>
    );
  }

  return (
    <>
      {sidebarOpen ? <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} /> : null}
      <div className="app-shell">
        <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="sidebar-topbar">
            <div>
              <div className="eyebrow">Connected</div>
              <div className="sidebar-subtitle">@{session.user.login}</div>
            </div>
            <button className="ghost-button" onClick={() => setSidebarOpen(false)}>Close</button>
          </div>

          <div className="sidebar-header">
            <h1>Assistant</h1>
            <div className="sidebar-header-actions">
              <IconButton label="Start new chat" onClick={() => void handleCreateChat()}>
                <PlusIcon />
              </IconButton>
              <IconButton label="Open settings" onClick={() => setSettingsVisible(true)}>
                <SettingsIcon />
              </IconButton>
            </div>
          </div>

          <div className="sidebar-scroll">
            <div
              className={`sidebar-create${draggedChatId ? ' visible' : ''}${dragOverGroupId === 'new-project' ? ' drag-over' : ''}`}
              onDragOver={(event) => handleWorkspaceDragOver(event, 'new-project')}
              onDragLeave={() => setDragOverGroupId((current) => (current === 'new-project' ? null : current))}
              onDrop={(event) => void handleCreateProjectDrop(event)}
            >
              <input
                className="sidebar-create-input"
                placeholder="New project…"
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
              />
              <button
                className="sidebar-create-btn"
                disabled={creatingProject || !newProjectName.trim()}
                onClick={() => void handleCreateProject()}
              >
                {creatingProject ? '…' : 'Add'}
              </button>
            </div>

            {workspaceGroups.map((group) => (
              <div
                key={group.id ?? 'inbox'}
                className={`sidebar-group${dragOverGroupId === (group.id ?? 'inbox') ? ' drag-over' : ''}`}
                onDragOver={(event) => handleWorkspaceDragOver(event, group.id ?? 'inbox')}
                onDragLeave={() => setDragOverGroupId((current) => (current === (group.id ?? 'inbox') ? null : current))}
                onDrop={(event) => void handleWorkspaceDrop(event, group.id)}
              >
                <div className="sidebar-group-head">
                  <span className="sidebar-group-label">{group.label}</span>
                  <span className="sidebar-group-count">{group.chats.length}</span>
                  {!group.isInbox ? (
                    <button className="sidebar-group-new" onClick={() => void handleCreateChat(group.id)}>+</button>
                  ) : null}
                </div>
                {group.chats.length === 0 ? (
                  <div className="sidebar-group-empty">{draggedChatId ? 'Drop here' : 'No chats'}</div>
                ) : (
                  group.chats.map((chat) => (
                    <button
                      key={chat.id}
                      className={`sidebar-item${chat.id === selectedChat?.id ? ' active' : ''}${streamingChatIds.has(chat.id) ? ' streaming' : ''}`}
                      onClick={() => void handleSelectChat(chat.id)}
                      draggable
                      onDragStart={() => handleChatDragStart(chat.id)}
                      onDragEnd={handleChatDragEnd}
                      disabled={movingChatId === chat.id}
                    >
                      <span className="sidebar-item-title">
                        {streamingChatIds.has(chat.id) ? <span className="sidebar-item-pulse" /> : null}
                        {chat.title}
                      </span>
                      <span className="sidebar-item-preview">{chat.lastMessagePreview ?? 'New conversation'}</span>
                    </button>
                  ))
                )}
              </div>
            ))}
          </div>
        </aside>

        <main className="main-panel">
          <header className="main-header">
            <div className="main-header-leading">
              <IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)} className="mobile-menu-trigger">
                <MenuIcon />
              </IconButton>
              <div className="header-copy">
                <h1 className="main-title">{selectedChat?.title ?? 'New chat'}</h1>
                {headerMeta ? <div className="main-subtitle">{headerMeta}</div> : null}
              </div>
            </div>
            <div className="main-header-actions">
              <label className="header-model-field" htmlFor="header-model">
                <span className="header-model-label">Model</span>
                <select
                  id="header-model"
                  className="select header-model-select"
                  value={activeModelId}
                  onChange={(event) => {
                    if (!selectedChat) return;
                    const nextModelId = event.target.value;
                    const nextModel = models.find((model) => model.id === nextModelId);
                    const nextReasoningEffort =
                      nextModel?.capabilities?.supports.reasoningEffort
                        ? selectedChat.reasoningEffort && nextModel.supportedReasoningEfforts?.includes(selectedChat.reasoningEffort)
                          ? selectedChat.reasoningEffort
                          : nextModel.defaultReasoningEffort ?? nextModel.supportedReasoningEfforts?.[0] ?? null
                        : null;
                    void handleThreadConfigChange(selectedChat.id, { model: nextModelId, reasoningEffort: nextReasoningEffort });
                  }}
                  disabled={!selectedChat || !models.length || savingThreadConfigId === selectedChat?.id}
                >
                  {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </label>
              {selectedChat && selectedModel?.capabilities?.supports.reasoningEffort ? (
                <label className="header-model-field" htmlFor="header-reasoning">
                  <span className="header-model-label">Thinking</span>
                  <select
                    id="header-reasoning"
                    className="select header-model-select"
                    value={activeReasoningEffort ?? ''}
                    onChange={(event) =>
                      void handleThreadConfigChange(selectedChat.id, {
                        reasoningEffort: (event.target.value || null) as ReasoningEffort | null,
                      })
                    }
                    disabled={!selectedReasoningEfforts.length || savingThreadConfigId === selectedChat.id}
                  >
                    {selectedReasoningEfforts.map((effort) => (
                      <option key={effort} value={effort}>{effort}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <IconButton label="Start new chat" onClick={() => void handleCreateChat()}>
                <PlusIcon />
              </IconButton>
            </div>
          </header>

          <div className="message-scroll" ref={messagesRef}>
            {!isOnline ? <div className="top-banner offline">You are offline. The app shell is cached, but your daemon must be reachable to sign in and chat.</div> : null}
            {loading ? (
              <div className="empty-state"><div><h2>Loading…</h2><p>Restoring your threads and daemon health.</p></div></div>
            ) : selectedChat?.messages.length ? (
              <div className="message-list">
                {selectedChat.messages.map((message, index) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    isStreaming={
                      streamingChatIds.has(selectedChat.id) &&
                      message.role === 'assistant' &&
                      index === selectedChat.messages.length - 1
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state"><div><h2>Start the thread</h2><p>Messages persist on your daemon. Reconnect from any browser.</p></div></div>
            )}
          </div>

          <footer className="composer">
            {error ? <div className="error-banner">{error}</div> : null}

            <input ref={fileInputRef} className="hidden-input" type="file" multiple onChange={handleFilesSelected} />

            {selectedChat?.draftAttachments.length ? (
              <div className="composer-drafts">
                {selectedChat.draftAttachments.map((attachment) => (
                  <div key={attachment.id} className="composer-draft">
                    <span>{attachment.name}</span>
                    <button className="composer-draft-remove" onClick={() => handleRemoveAttachment(attachment.id)}>×</button>
                  </div>
                ))}
              </div>
            ) : null}

            {selectedChat?.pendingUserInputRequest ? (
              <div className="user-input-card">
                <div className="status-label">Copilot needs input</div>
                <div className="user-input-question">{selectedChat.pendingUserInputRequest.question}</div>
                {selectedChat.pendingUserInputRequest.choices?.length ? (
                  <div className="user-input-choices">
                    {selectedChat.pendingUserInputRequest.choices.map((choice) => (
                      <button
                        key={choice}
                        className="ghost-button"
                        disabled={respondingToUserInputId === selectedChat.pendingUserInputRequest?.requestId}
                        onClick={() => void handleRespondToPendingInput(selectedChat.pendingUserInputRequest!.requestId, choice)}
                      >
                        {choice}
                      </button>
                    ))}
                  </div>
                ) : null}
                {selectedChat.pendingUserInputRequest.allowFreeform ? (
                  <div className="inline-form">
                    <input
                      className="input"
                      value={userInputDrafts[selectedChat.pendingUserInputRequest.requestId] ?? ''}
                      onChange={(event) =>
                        setUserInputDrafts((current) => ({
                          ...current,
                          [selectedChat.pendingUserInputRequest!.requestId]: event.target.value,
                        }))
                      }
                      placeholder="Type your answer"
                    />
                    <button
                      className="button"
                      disabled={
                        respondingToUserInputId === selectedChat.pendingUserInputRequest.requestId ||
                        !(userInputDrafts[selectedChat.pendingUserInputRequest.requestId] ?? '').trim()
                      }
                      onClick={() =>
                        void handleRespondToPendingInput(
                          selectedChat.pendingUserInputRequest!.requestId,
                          (userInputDrafts[selectedChat.pendingUserInputRequest!.requestId] ?? '').trim(),
                        )
                      }
                    >
                      {respondingToUserInputId === selectedChat.pendingUserInputRequest.requestId ? 'Sending…' : 'Send'}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="composer-bar">
              <button
                type="button"
                className={`composer-btn${uploadingAttachment ? ' is-busy' : ''}`}
                onClick={handleChooseFiles}
                disabled={uploadingAttachment}
                aria-label="Attach files"
              >
                <PaperclipIcon />
              </button>
              <textarea
                ref={composerRef}
                className="composer-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={selectedChat?.projectName ? `Ask about ${selectedChat.projectName}…` : 'Message…'}
                rows={1}
              />
              <button
                type="button"
                className="composer-send"
                onClick={() => void (isSelectedChatStreaming ? handleAbortStreaming() : handleSend())}
                disabled={isSelectedChatStreaming ? false : !draft.trim()}
                aria-label={isSelectedChatStreaming ? 'Stop response' : 'Send message'}
              >
                {isSelectedChatStreaming ? <StopIcon /> : <SendIcon />}
              </button>
            </div>
          </footer>
        </main>
      </div>
      {settingsModal}
      {connectionModal}
    </>
  );
}
