import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AttachmentSummary,
  ApiHealth,
  ChatMessage,
  ModelOption,
  ProjectSummary,
  ThreadDetail,
  ThreadSummary,
} from '@github-personal-assistant/shared';

import { MessageBubble } from './components/message-bubble.js';
import {
  createProject,
  createThread,
  getHealth,
  getModels,
  getProjects,
  getThread,
  getThreads,
  promoteAttachmentToKnowledge,
  streamChat,
  uploadAttachment,
} from './lib/api.js';
import { clearApiUrlOverride, getApiUrlOverride, getDefaultApiUrl, setApiUrlOverride } from './lib/api-config.js';
import { applyPwaUpdate, PWA_UPDATE_EVENT } from './lib/pwa-updates.js';
import { useAuth } from './providers/auth-provider.js';

type LocalChat = ThreadDetail & {
  draftAttachments: AttachmentSummary[];
  hasLoadedMessages: boolean;
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
const toLocalChatSummary = (thread: ThreadSummary): LocalChat => ({ ...thread, messages: [], draftAttachments: [], hasLoadedMessages: false });
const mergeThreadIntoLocal = (thread: ThreadSummary, existing?: LocalChat): LocalChat => ({
  ...thread,
  messages: existing?.messages ?? [],
  draftAttachments: existing?.draftAttachments ?? [],
  hasLoadedMessages: existing?.hasLoadedMessages ?? false,
});
const mergeThreadDetailIntoLocal = (thread: ThreadDetail, existing?: LocalChat): LocalChat => ({
  ...thread,
  messages: sortMessages(thread.messages),
  draftAttachments: existing?.draftAttachments ?? [],
  hasLoadedMessages: true,
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
  const [promotingAttachmentId, setPromotingAttachmentId] = useState<string | null>(null);
  const [streamingChatId, setStreamingChatId] = useState<string | null>(null);
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
  const [isUpdateReady, setIsUpdateReady] = useState(false);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handlePwaUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ available?: boolean }>).detail;
      setIsUpdateReady(Boolean(detail?.available));
    };

    window.addEventListener(PWA_UPDATE_EVENT, handlePwaUpdate as EventListener);
    return () => {
      window.removeEventListener(PWA_UPDATE_EVENT, handlePwaUpdate as EventListener);
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

      const [healthPayload, projectsPayload, modelsPayload, threadsPayload] = await Promise.all([
        getHealth(),
        getProjects(session.sessionToken),
        getModels(session.sessionToken),
        getThreads(session.sessionToken),
      ]);

      setHealth(healthPayload);
      setProjects(projectsPayload.projects);
      setModels(modelsPayload.models);
      setChats((current) => {
        const existingById = new Map(current.map((chat) => [chat.id, chat]));
        return threadsPayload.threads.map((thread) => mergeThreadIntoLocal(thread, existingById.get(thread.id)));
      });

      if (threadsPayload.threads.length === 0) {
        await ensureInitialThread();
        return;
      }

      const nextSelectedChatId =
        (selectedChatId && threadsPayload.threads.some((thread) => thread.id === selectedChatId) ? selectedChatId : undefined) ??
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
  }, [ensureInitialThread, loadThreadDetail, selectedChatId, session, signOut]);

  useEffect(() => {
    if (!isRestoring) {
      void load();
    }
  }, [isRestoring, load]);

  const selectedChat = useMemo(() => chats.find((chat) => chat.id === selectedChatId) ?? chats[0] ?? null, [chats, selectedChatId]);
  const orderedChats = useMemo(() => [...chats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [chats]);
  const activeModelId = selectedChat?.model ?? defaultModel;
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

  const handleApplyUpdate = useCallback(async () => {
    setIsApplyingUpdate(true);
    setError(null);

    try {
      const didStartUpdate = await applyPwaUpdate();
      if (!didStartUpdate) {
        setIsUpdateReady(false);
        setError('The latest version is ready after a refresh. Reload this page to apply the update.');
      }
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to apply the latest app update.');
    } finally {
      setIsApplyingUpdate(false);
    }
  }, []);

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

  const handleCreateChat = useCallback(async () => {
    if (!session) return;
    setError(null);
    try {
      const payload = await createThread({}, session.sessionToken);
      upsertThreadSummary(payload.thread);
      setSelectedChatId(payload.thread.id);
      await loadThreadDetail(payload.thread.id);
      setDraft('');
      setSidebarOpen(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create chat.');
    }
  }, [loadThreadDetail, session, upsertThreadSummary]);

  const handleStartProjectChat = useCallback(
    async (project: ProjectSummary) => {
      if (!session) return;
      setError(null);
      try {
        const payload = await createThread({ projectId: project.id, model: project.defaultModel }, session.sessionToken);
        upsertThreadSummary(payload.thread);
        setSelectedChatId(payload.thread.id);
        await loadThreadDetail(payload.thread.id);
        setDraft('');
        setSidebarOpen(false);
      } catch (createError) {
        setError(createError instanceof Error ? createError.message : 'Unable to create project chat.');
      }
    },
    [loadThreadDetail, session, upsertThreadSummary],
  );

  const handleCreateProject = useCallback(async () => {
    if (!session || !newProjectName.trim()) return;
    setCreatingProject(true);
    setError(null);
    try {
      const payload = await createProject({ name: newProjectName.trim() }, session.sessionToken);
      setProjects((current) => [payload.project, ...current]);
      setNewProjectName('');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create project.');
    } finally {
      setCreatingProject(false);
    }
  }, [newProjectName, session]);

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
            { threadId: selectedChat.id, projectId: selectedChat.projectId },
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

  const handlePromoteAttachment = useCallback(
    async (attachmentId: string) => {
      if (!session || !selectedChat?.projectId) return;
      setPromotingAttachmentId(attachmentId);
      setError(null);
      try {
        const payload = await promoteAttachmentToKnowledge(attachmentId, { projectId: selectedChat.projectId }, session.sessionToken);
        updateChat(selectedChat.id, (chat) => ({
          ...chat,
          draftAttachments: chat.draftAttachments.map((attachment) => (attachment.id === attachmentId ? payload.attachment : attachment)),
        }));
      } catch (promoteError) {
        setError(promoteError instanceof Error ? promoteError.message : 'Unable to add that file to project knowledge.');
      } finally {
        setPromotingAttachmentId(null);
      }
    },
    [selectedChat, session, updateChat],
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
    if (!session || !selectedChat || !draft.trim() || streamingChatId) {
      return;
    }

    const prompt = draft.trim();
    const assistantMessageId = createId();
    const chatId = selectedChat.id;
    const model = selectedChat.model || defaultModel;
    const messageAttachments = selectedChat.draftAttachments;
    let pendingDelta = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushPendingDelta = () => {
      if (!pendingDelta) {
        return;
      }
      const nextDelta = pendingDelta;
      pendingDelta = '';
      updateChat(chatId, (chat) => ({
        ...chat,
        updatedAt: new Date().toISOString(),
        messages: sortMessages(
          chat.messages.map((message) =>
            message.id === assistantMessageId ? { ...message, content: `${message.content}${nextDelta}` } : message,
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
    setStreamingChatId(chatId);
    updateChat(chatId, (chat) => ({
      ...chat,
      title: chat.title === 'New chat' ? summarizeTitle(prompt) : chat.title,
      model,
      updatedAt: new Date().toISOString(),
      draftAttachments: [],
      messages: sortMessages([
        ...chat.messages,
        createMessage('user', prompt, messageAttachments),
        { id: assistantMessageId, role: 'assistant', content: '', createdAt: new Date().toISOString() },
      ]),
      hasLoadedMessages: true,
    }));

    try {
      await streamChat(
        { threadId: chatId, prompt, model, attachments: messageAttachments.map((attachment) => attachment.id) },
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
          if (event.type === 'error') {
            if (flushTimer !== null) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            flushPendingDelta();
            updateChat(chatId, (chat) => ({
              ...chat,
              updatedAt: new Date().toISOString(),
              messages: sortMessages(
                chat.messages.map((message) =>
                  message.id === assistantMessageId ? { ...message, role: 'error', content: event.message } : message,
                ),
              ),
            }));
            setError(event.message);
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
      setStreamingChatId(null);
    }
  }, [defaultModel, draft, loadThreadDetail, selectedChat, session, signOut, streamingChatId, updateChat]);

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

  const settingsModal = settingsVisible ? (
    <div className="modal-backdrop" onClick={() => setSettingsVisible(false)}>
      <div className="modal-card narrow" onClick={(event) => event.stopPropagation()}>
        <h2 className="modal-title">Settings</h2>
          <p className="modal-copy">Signed in as @{session?.user.login}</p>
          <div className="status-grid">
            <div className="status-item"><div className="status-label">Daemon</div><div className="status-value">{activeApiUrl}</div></div>
            <div className="status-item"><div className="status-label">Remote access</div><div className="status-value">{remoteAccessLabel}</div></div>
            <div className="status-item"><div className="status-label">RagFlow</div><div className="status-value">{health?.ragflowConfigured ? 'Connected' : 'Not configured'}</div></div>
            <div className="status-item"><div className="status-label">Auth</div><div className="status-value">{health?.authConfigured ? activeAuthLabel : 'Not configured'}</div></div>
            <div className="status-item"><div className="status-label">Install</div><div className="status-value">{isStandalone ? 'Installed' : installPromptEvent ? 'Ready to install' : 'Browser install available'}</div></div>
            <div className="status-item"><div className="status-label">Connectivity</div><div className="status-value"><span className="status-inline"><span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />{isOnline ? 'Online' : 'Offline'}</span></div></div>
          </div>
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

  const renderUpdateBanner = () =>
    isUpdateReady ? (
      <div className="top-banner update-ready">
        <div>
          <strong>Update ready.</strong> A newer version of this app is available.
        </div>
        <button className="ghost-button" onClick={() => void handleApplyUpdate()} disabled={isApplyingUpdate}>
          {isApplyingUpdate ? 'Updating...' : 'Update now'}
        </button>
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
            {renderUpdateBanner()}

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
            <h1>Github Personal Assistant</h1>
            <div className="sidebar-subtitle">@{session.user.login}</div>
          </div>

          <div className="sidebar-scroll">
            <section className="section-card">
              <div className="section-header">
                <h2 className="section-title">Chats</h2>
                <div className="section-header-actions">
                  <span className="chip">{orderedChats.length}</span>
                  <IconButton label="Start new chat" onClick={() => void handleCreateChat()}>
                    <PlusIcon />
                  </IconButton>
                </div>
              </div>
              <div className="sidebar-list">
                {orderedChats.map((chat) => (
                  <button key={chat.id} className={`chat-row ${chat.id === selectedChat?.id ? 'active' : ''}`} onClick={() => void handleSelectChat(chat.id)}>
                    <span className="chat-title">{chat.title}</span>
                    <span className="chat-meta">{chat.projectName ?? chat.lastMessagePreview ?? 'General chat'}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="section-card">
              <div className="section-header">
                <h2 className="section-title">Projects</h2>
                <span className="chip">Knowledge scoped</span>
              </div>
              <div className="inline-form">
                <input className="input" placeholder="Create a project" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} />
                <button className="ghost-button" disabled={creatingProject || !newProjectName.trim()} onClick={() => void handleCreateProject()}>
                  {creatingProject ? 'Creating...' : 'Add project'}
                </button>
              </div>
              <div className="project-list">
                {projects.map((project) => (
                  <div key={project.id} className="project-row">
                    <div className="project-title">{project.name}</div>
                    <div className="project-meta">Default model: {project.defaultModel}</div>
                    <div className="project-actions">
                      <button className="ghost-button" onClick={() => void handleStartProjectChat(project)}>Start project chat</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </aside>

        <main className="main-panel">
          <header className="main-header">
            <div className="main-header-leading">
              <IconButton label="Open chats and projects" onClick={() => setSidebarOpen(true)} className="mobile-menu-trigger">
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
                    if (!selectedChat) {
                      return;
                    }
                    updateChat(selectedChat.id, (chat) => ({ ...chat, model: event.target.value }));
                  }}
                  disabled={!selectedChat || !models.length}
                >
                  {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </label>
              <IconButton label="Start new chat" onClick={() => void handleCreateChat()}>
                <PlusIcon />
              </IconButton>
              <IconButton label="Open settings" onClick={() => setSettingsVisible(true)}>
                <SettingsIcon />
              </IconButton>
            </div>
          </header>

          <div className="message-scroll" ref={messagesRef}>
            {!isOnline ? <div className="top-banner offline">You are offline. The app shell is cached, but your daemon must be reachable to sign in and chat.</div> : null}
            {renderUpdateBanner()}
            {loading ? (
              <div className="empty-state"><div><h2>Loading assistant…</h2><p>Restoring projects, threads, and daemon health.</p></div></div>
            ) : selectedChat?.messages.length ? (
              <div className="message-list">
                {selectedChat.messages.map((message) => <MessageBubble key={message.id} message={message} />)}
              </div>
            ) : (
              <div className="empty-state"><div><h2>Start the thread</h2><p>Messages persist on your daemon, so you can reconnect from any browser that knows your daemon URL.</p></div></div>
            )}
          </div>

          <footer className="composer">
            {error ? <div className="error-banner">{error}</div> : null}

            <input ref={fileInputRef} className="hidden-input" type="file" multiple onChange={handleFilesSelected} />

            {selectedChat?.draftAttachments.length ? (
              <div className="composer-attachments">
                {selectedChat.draftAttachments.map((attachment) => (
                  <div key={attachment.id} className="draft-attachment">
                    <div>
                      <div className="chat-title">{attachment.name}</div>
                      <div className="chat-meta">
                        {attachment.scope === 'knowledge'
                          ? attachment.knowledgeStatus === 'pending'
                            ? 'Project knowledge syncing...'
                            : attachment.knowledgeStatus === 'indexed'
                              ? 'Project knowledge indexed'
                              : attachment.knowledgeStatus === 'failed'
                                ? 'Knowledge sync failed'
                                : 'Project knowledge'
                          : 'Thread-only attachment'}
                      </div>
                    </div>
                    <div className="attachment-actions">
                      {selectedChat.projectId && attachment.scope !== 'knowledge' ? (
                        <button className="text-button" onClick={() => void handlePromoteAttachment(attachment.id)}>
                          {promotingAttachmentId === attachment.id ? 'Promoting...' : 'Add to knowledge'}
                        </button>
                      ) : null}
                      <button className="text-button remove" onClick={() => handleRemoveAttachment(attachment.id)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="composer-shell">
              <textarea
                className="textarea composer-textarea"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={selectedChat?.projectName ? `Ask about ${selectedChat.projectName}...` : 'Ask anything...'}
              />
              <div className="composer-controls">
                <div className="composer-tools">
                  <IconButton
                    label={uploadingAttachment ? 'Uploading files' : 'Add files'}
                    onClick={handleChooseFiles}
                    disabled={uploadingAttachment}
                    className={uploadingAttachment ? 'is-busy composer-tool-button' : 'composer-tool-button'}
                  >
                    <PaperclipIcon />
                  </IconButton>
                </div>
                <button
                  type="button"
                  className="composer-send-button"
                  onClick={() => void handleSend()}
                  disabled={Boolean(streamingChatId) || !draft.trim()}
                  aria-label={streamingChatId ? 'Streaming response' : 'Send message'}
                  title={streamingChatId ? 'Streaming response' : 'Send message'}
                >
                  <SendIcon />
                </button>
              </div>
            </div>
          </footer>
        </main>
      </div>
      {settingsModal}
      {connectionModal}
    </>
  );
}
