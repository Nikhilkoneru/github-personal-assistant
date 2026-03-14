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

import { MessageBubble } from './components/message-bubble';
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
} from './lib/api';
import { clearApiUrlOverride, getApiUrlOverride, getDefaultApiUrl, setApiUrlOverride } from './lib/api-config';
import { useAuth } from './providers/auth-provider';

type LocalChat = ThreadDetail & {
  draftAttachments: AttachmentSummary[];
  hasLoadedMessages: boolean;
};

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const sortMessages = (messages: ChatMessage[]) =>
  [...messages]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const byTime = left.message.createdAt.localeCompare(right.message.createdAt);
      return byTime !== 0 ? byTime : left.index - right.index;
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

export default function App() {
  const { openPendingGitHubVerification, pendingDeviceAuth, session, signInWithGitHub, signOut, isRestoring } = useAuth();
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
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const defaultModel = models[0]?.id ?? 'gpt-5-mini';
  const suggestedApiUrl = health?.tailscaleApiUrl ?? health?.publicApiUrl ?? health?.apiOrigin ?? null;
  const activeApiUrl = savedApiUrlOverride ?? suggestedApiUrl ?? getDefaultApiUrl();
  const remoteAccessLabel =
    health?.remoteAccessMode === 'tailscale' ? 'Tailscale' : health?.remoteAccessMode === 'public' ? 'Public URL' : 'Local only';

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

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' });
  }, [selectedChat?.id, selectedChat?.messages]);

  const openConnectionSettings = useCallback(() => {
    setError(null);
    void refreshConnectionState();
    setConnectionSettingsVisible(true);
  }, [refreshConnectionState]);

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
      await load();
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : 'Unable to save the API endpoint.');
    } finally {
      setSavingConnection(false);
    }
  }, [apiUrlInput, load, refreshConnectionState]);

  const handleResetConnection = useCallback(async () => {
    setSavingConnection(true);
    setError(null);
    try {
      await clearApiUrlOverride();
      await refreshConnectionState();
      await load();
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : 'Unable to reset the API endpoint.');
    } finally {
      setSavingConnection(false);
    }
  }, [load, refreshConnectionState]);

  const handleAuthPress = useCallback(() => {
    setError(null);
    const action = pendingDeviceAuth ? openPendingGitHubVerification() : signInWithGitHub();
    void action.catch((authError) => {
      setError(authError instanceof Error ? authError.message : 'Unable to complete GitHub sign-in.');
    });
  }, [openPendingGitHubVerification, pendingDeviceAuth, signInWithGitHub]);

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
          <div className="status-item"><div className="status-label">Auth</div><div className="status-value">{health?.authConfigured ? 'Configured' : 'Missing GitHub client ID'}</div></div>
        </div>
        <div className="modal-actions">
          <button className="ghost-button" onClick={() => { setSettingsVisible(false); openConnectionSettings(); }}>Connection</button>
          <button className="ghost-button" onClick={() => setSettingsVisible(false)}>Close</button>
          <button className="danger-button" onClick={() => { setSettingsVisible(false); void signOut(); }}>Sign out</button>
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
            <div className="eyebrow">Github Personal Assistant</div>
            <h1>Bring your own daemon, keep your own history.</h1>
            <p className="muted">Use GitHub device sign-in to connect this React web client to your personal assistant service.</p>

            <div className="status-card">
              <div className="status-grid">
                <div className="status-item"><div className="status-label">Daemon endpoint</div><div className="status-value">{activeApiUrl}</div></div>
                <div className="status-item"><div className="status-label">Remote access</div><div className="status-value">{remoteAccessLabel}</div></div>
              </div>
            </div>

            {pendingDeviceAuth ? (
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
              <button className="button" onClick={handleAuthPress}>{pendingDeviceAuth ? 'Open verification page' : 'Sign in with GitHub'}</button>
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

          <button className="button" onClick={() => void handleCreateChat()}>+ New chat</button>

          <div className="sidebar-scroll">
            <section className="section-card">
              <div className="section-header">
                <h2 className="section-title">Chats</h2>
                <span className="chip">{orderedChats.length}</span>
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
            <div>
              <div className="main-header-actions mobile-menu">
                <button className="ghost-button" onClick={() => setSidebarOpen(true)}>Menu</button>
              </div>
              <h1 className="main-title">{selectedChat?.title ?? 'New chat'}</h1>
              <div className="main-subtitle">
                {selectedChat?.projectName ? `Project: ${selectedChat.projectName}` : 'No project attached'}
                {selectedChat?.copilotSessionId ? ' · resumable' : ''}
              </div>
            </div>
            <div className="main-header-actions">
              <select className="select" value={selectedChat?.model ?? defaultModel} onChange={(event) => selectedChat && updateChat(selectedChat.id, (chat) => ({ ...chat, model: event.target.value }))}>
                {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
              <button className="ghost-button" onClick={() => setSettingsVisible(true)}>Settings</button>
            </div>
          </header>

          <div className="message-scroll" ref={messagesRef}>
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

            <textarea className="textarea" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={selectedChat?.projectName ? `Ask about ${selectedChat.projectName}...` : 'Ask anything...'} />
            <div className="composer-toolbar">
              <div className="composer-footer">
                <button className="ghost-button" onClick={handleChooseFiles} disabled={uploadingAttachment}>{uploadingAttachment ? 'Uploading...' : 'Attach files'}</button>
                <div className="helper-text">Files stay thread-local unless you promote them to project knowledge.</div>
              </div>
              <button className="button" onClick={() => void handleSend()} disabled={Boolean(streamingChatId) || !draft.trim()}>
                {streamingChatId ? 'Streaming...' : 'Send'}
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
