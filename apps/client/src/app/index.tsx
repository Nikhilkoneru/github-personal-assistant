import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

import type {
  AttachmentSummary,
  ApiHealth,
  ChatMessage,
  ModelOption,
  ProjectSummary,
  ThreadDetail,
  ThreadSummary,
} from '@github-personal-assistant/shared';

import { MessageBubble } from '@/components/message-bubble';
import { Screen } from '@/components/screen';
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
} from '@/lib/api';
import {
  clearApiUrlOverride,
  getApiUrlOverride,
  getDefaultApiUrl,
  setApiUrlOverride,
} from '@/lib/api-config';
import { useAuth } from '@/providers/auth-provider';

type LocalChat = ThreadDetail & {
  draftAttachments: AttachmentSummary[];
  hasLoadedMessages: boolean;
};

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const createMessage = (
  role: ChatMessage['role'],
  content: string,
  attachments?: AttachmentSummary[],
): ChatMessage => ({
  id: createId(),
  role,
  content,
  createdAt: new Date().toISOString(),
  ...(attachments && attachments.length > 0 ? { attachments } : {}),
});

const toLocalChatSummary = (thread: ThreadSummary): LocalChat => ({
  ...thread,
  messages: [],
  draftAttachments: [],
  hasLoadedMessages: false,
});

const mergeThreadIntoLocal = (thread: ThreadSummary, existing?: LocalChat): LocalChat => ({
  ...thread,
  messages: existing?.messages ?? [],
  draftAttachments: existing?.draftAttachments ?? [],
  hasLoadedMessages: existing?.hasLoadedMessages ?? false,
});

const mergeThreadDetailIntoLocal = (thread: ThreadDetail, existing?: LocalChat): LocalChat => ({
  ...thread,
  messages: thread.messages,
  draftAttachments: existing?.draftAttachments ?? [],
  hasLoadedMessages: true,
});

export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const compact = width < 960;
  const { openPendingGitHubVerification, pendingDeviceAuth, session, signInWithGitHub, signOut } = useAuth();

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
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [apiUrlInput, setApiUrlInput] = useState(getDefaultApiUrl());
  const [savedApiUrlOverride, setSavedApiUrlOverride] = useState<string | null>(null);
  const [savingConnection, setSavingConnection] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesScrollRef = useRef<ScrollView>(null);

  const defaultModel = models[0]?.id ?? 'gpt-5-mini';
  const suggestedApiUrl = health?.tailscaleApiUrl ?? health?.publicApiUrl ?? health?.apiOrigin ?? null;
  const activeApiUrl = savedApiUrlOverride ?? suggestedApiUrl ?? getDefaultApiUrl();
  const remoteAccessLabel =
    health?.remoteAccessMode === 'tailscale'
      ? 'Tailscale'
      : health?.remoteAccessMode === 'public'
        ? 'Public URL'
        : 'Local only';

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
    void load();
  }, [load]);

  const selectedChat = useMemo(
    () => chats.find((chat) => chat.id === selectedChatId) ?? chats[0] ?? null,
    [chats, selectedChatId],
  );

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedChat?.model) ?? models[0] ?? null,
    [models, selectedChat?.model],
  );

  const orderedChats = useMemo(
    () => [...chats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [chats],
  );

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      messagesScrollRef.current?.scrollToEnd({ animated: true });
    }, 0);

    return () => clearTimeout(timeoutId);
  }, [selectedChat?.id, selectedChat?.messages]);

  const handleAuthPress = useCallback(() => {
    setError(null);

    const action = pendingDeviceAuth ? openPendingGitHubVerification() : signInWithGitHub();
    void action.catch((authError) => {
      setError(authError instanceof Error ? authError.message : 'Unable to complete GitHub sign-in.');
    });
  }, [openPendingGitHubVerification, pendingDeviceAuth, signInWithGitHub]);

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

  const handleCreateChat = useCallback(async () => {
    if (!session) {
      return;
    }

    setError(null);
    try {
      const payload = await createThread({}, session.sessionToken);
      upsertThreadSummary(payload.thread);
      setSelectedChatId(payload.thread.id);
      await loadThreadDetail(payload.thread.id);
      setDraft('');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create chat.');
    }
  }, [loadThreadDetail, session, upsertThreadSummary]);

  const handleStartProjectChat = useCallback(
    async (project: ProjectSummary) => {
      if (!session) {
        return;
      }

      setError(null);
      try {
        const payload = await createThread({ projectId: project.id, model: project.defaultModel }, session.sessionToken);
        upsertThreadSummary(payload.thread);
        setSelectedChatId(payload.thread.id);
        await loadThreadDetail(payload.thread.id);
        setDraft('');
      } catch (createError) {
        setError(createError instanceof Error ? createError.message : 'Unable to create project chat.');
      }
    },
    [loadThreadDetail, session, upsertThreadSummary],
  );

  const handleCreateProject = useCallback(async () => {
    if (!session || !newProjectName.trim()) {
      return;
    }

    setCreatingProject(true);
    setError(null);

    try {
      const payload = await createProject({ name: newProjectName.trim() }, session.sessionToken);
      setProjects((current) => [payload.project, ...current]);
      setNewProjectName('');
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : 'Unable to create project.';
      setError(message);
    } finally {
      setCreatingProject(false);
    }
  }, [newProjectName, session]);

  const handleSelectModel = useCallback(
    (modelId: string) => {
      if (!selectedChat) {
        return;
      }

      updateChat(selectedChat.id, (chat) => ({ ...chat, model: modelId }));
      setModelPickerVisible(false);
    },
    [selectedChat, updateChat],
  );

  const handleSelectChat = useCallback(
    async (chatId: string) => {
      setSelectedChatId(chatId);
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

  const handleAddAttachment = useCallback(async () => {
    if (!session || !selectedChat || uploadingAttachment) {
      return;
    }

    setUploadingAttachment(true);
    setError(null);

    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
        type: '*/*',
      });

      if (result.canceled) {
        return;
      }

      const remainingSlots = Math.max(0, 5 - selectedChat.draftAttachments.length);
      if (remainingSlots === 0) {
        setError('You can attach up to 5 files per message.');
        return;
      }

      const nextAssets = result.assets.slice(0, remainingSlots);
      const uploadedAttachments: AttachmentSummary[] = [];

      for (const asset of nextAssets) {
        const payload = await uploadAttachment(
          {
            uri: asset.uri,
            name: asset.name,
            mimeType: asset.mimeType ?? 'application/octet-stream',
            file: 'file' in asset ? asset.file : undefined,
          },
          session.sessionToken,
          {
            threadId: selectedChat.id,
            projectId: selectedChat.projectId,
          },
        );
        uploadedAttachments.push(payload.attachment);
      }

      if (uploadedAttachments.length > 0) {
        updateChat(selectedChat.id, (chat) => ({
          ...chat,
          draftAttachments: [...chat.draftAttachments, ...uploadedAttachments],
        }));
      }
    } catch (attachmentError) {
      setError(attachmentError instanceof Error ? attachmentError.message : 'Unable to attach file.');
    } finally {
      setUploadingAttachment(false);
    }
  }, [selectedChat, session, updateChat, uploadingAttachment]);

  const handlePromoteAttachment = useCallback(
    async (attachmentId: string) => {
      if (!session || !selectedChat?.projectId) {
        return;
      }

      setPromotingAttachmentId(attachmentId);
      setError(null);

      try {
        const payload = await promoteAttachmentToKnowledge(attachmentId, { projectId: selectedChat.projectId }, session.sessionToken);
        updateChat(selectedChat.id, (chat) => ({
          ...chat,
          draftAttachments: chat.draftAttachments.map((attachment) =>
            attachment.id === attachmentId ? payload.attachment : attachment,
          ),
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
      if (!selectedChat) {
        return;
      }

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
        messages: chat.messages.map((message) =>
          message.id === assistantMessageId
            ? { ...message, content: `${message.content}${nextDelta}` }
            : message,
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
      title: chat.title === 'New chat' ? prompt.slice(0, 42) : chat.title,
      model,
      updatedAt: new Date().toISOString(),
      draftAttachments: [],
      messages: [
        ...chat.messages,
        createMessage('user', prompt, messageAttachments),
        { id: assistantMessageId, role: 'assistant', content: '', createdAt: new Date().toISOString() },
      ],
      hasLoadedMessages: true,
    }));

    try {
      await streamChat(
        {
          threadId: chatId,
          prompt,
          model,
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

          if (event.type === 'error') {
            if (flushTimer !== null) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            flushPendingDelta();
            updateChat(chatId, (chat) => ({
              ...chat,
              updatedAt: new Date().toISOString(),
              messages: chat.messages.map((message) =>
                message.id === assistantMessageId
                  ? { ...message, role: 'error', content: event.message }
                  : message,
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
        messages: chat.messages.map((messageItem) =>
          messageItem.id === assistantMessageId
            ? { ...messageItem, role: 'error', content: message }
            : messageItem,
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

  const renderPendingDeviceAuth = () => {
    if (!pendingDeviceAuth) {
      return null;
    }

    return (
      <View style={styles.deviceAuthCard}>
        <Text style={styles.deviceAuthLabel}>GitHub device sign-in</Text>
        <Text style={styles.deviceAuthCode}>{pendingDeviceAuth.userCode}</Text>
        <Text style={styles.deviceAuthBody}>
          Open GitHub&apos;s verification page, enter the code, and this screen will keep polling until sign-in completes.
        </Text>
        <Text style={styles.deviceAuthLink}>{pendingDeviceAuth.verificationUri}</Text>
        <Text style={styles.deviceAuthMeta}>
          Expires at {new Date(pendingDeviceAuth.expiresAt).toLocaleTimeString()} · polling every {pendingDeviceAuth.interval}s
        </Text>
      </View>
    );
  };

  if (!session) {
    return (
      <Screen>
        <View style={styles.centeredLayout}>
          <View style={styles.signInCard}>
            <Text style={styles.eyebrow}>Github Personal Assistant</Text>
            <Text style={styles.signInTitle}>You must sign in to use this product.</Text>
            <Text style={styles.signInBody}>
              Use GitHub device OAuth to unlock the real Copilot-backed experience on web and Android.
            </Text>

            {renderPendingDeviceAuth()}

            {!pendingDeviceAuth && health && !health.authConfigured ? (
              <View style={styles.configHint}>
                <Text style={styles.configHintTitle}>GitHub sign-in setup</Text>
                <Text style={styles.configHintBody}>
                  Copy <Text style={styles.configHintCode}>.env.example</Text> to <Text style={styles.configHintCode}>.env</Text>, set
                  <Text style={styles.configHintCode}> GITHUB_CLIENT_ID</Text>, and restart the API.
                </Text>
              </View>
            ) : null}

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Pressable style={styles.primaryButton} onPress={handleAuthPress}>
              <Text style={styles.primaryButtonText}>{pendingDeviceAuth ? 'Open verification page' : 'Sign in with GitHub'}</Text>
            </Pressable>
            <Text style={styles.helperText}>Daemon endpoint: {activeApiUrl}</Text>

            <Pressable style={styles.secondaryButton} onPress={openConnectionSettings}>
              <Text style={styles.secondaryButtonText}>Connection settings</Text>
            </Pressable>
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={[styles.shell, compact && styles.shellCompact]}>
        <View style={[styles.sidebar, compact && styles.sidebarCompact]}>
          <View style={styles.sidebarHeader}>
            <Text style={styles.sidebarTitle}>Github Personal Assistant</Text>
            <Text style={styles.sidebarSubtitle}>@{session.user.login}</Text>
          </View>

          <Pressable style={styles.newChatButton} onPress={() => void handleCreateChat()}>
            <Text style={styles.primaryButtonText}>+ New chat</Text>
          </Pressable>

          <ScrollView style={styles.sidebarScroll} contentContainerStyle={styles.sidebarContent}>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Chats</Text>
              <View style={styles.sidebarList}>
                {orderedChats.map((chat) => {
                  const active = chat.id === selectedChat?.id;
                  return (
                    <Pressable
                      key={chat.id}
                      style={[styles.sidebarItem, active && styles.sidebarItemActive]}
                      onPress={() => {
                        void handleSelectChat(chat.id);
                      }}
                    >
                      <Text style={styles.sidebarItemTitle}>{chat.title}</Text>
                      <Text style={styles.sidebarItemMeta}>{chat.projectName ?? chat.lastMessagePreview ?? 'General chat'}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>Projects</Text>
                <Text style={styles.sectionHint}>Optional</Text>
              </View>
              <View style={styles.createProjectCard}>
                <TextInput
                  placeholder="Create a project"
                  placeholderTextColor="#64748b"
                  value={newProjectName}
                  onChangeText={setNewProjectName}
                  style={styles.sidebarInput}
                />
                <Pressable
                  style={[styles.secondaryButton, creatingProject && styles.disabledButton]}
                  onPress={() => {
                    void handleCreateProject();
                  }}
                  disabled={creatingProject}
                >
                  <Text style={styles.secondaryButtonText}>{creatingProject ? 'Creating...' : 'Add project'}</Text>
                </Pressable>
              </View>
              <View style={styles.sidebarList}>
                {projects.map((project) => (
                  <Pressable
                    key={project.id}
                    style={styles.sidebarItem}
                    onPress={() => {
                      void handleStartProjectChat(project);
                    }}
                  >
                    <Text style={styles.sidebarItemTitle}>{project.name}</Text>
                    <Text style={styles.sidebarItemMeta}>Start project chat</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </ScrollView>
        </View>

        <View style={styles.mainPanel}>
          <View style={styles.mainHeader}>
            <View style={styles.mainHeaderText}>
              <Text style={styles.chatTitle}>{selectedChat?.title ?? 'New chat'}</Text>
              <Text style={styles.chatSubtitle}>
                {selectedChat?.projectName ? `Project: ${selectedChat.projectName}` : 'No project attached'}
                {selectedChat?.copilotSessionId ? ' · resumable' : ''}
              </Text>
            </View>
            <View style={styles.headerActions}>
              <Pressable style={styles.modelPillButton} onPress={() => setModelPickerVisible(true)}>
                <Text style={styles.modelPillText}>{selectedModel?.name ?? 'Choose model'}</Text>
                <Text style={styles.modelPillChevron}>▾</Text>
              </Pressable>
              <Pressable style={styles.settingsButton} onPress={() => setSettingsVisible(true)}>
                <Text style={styles.settingsButtonText}>⚙</Text>
              </Pressable>
            </View>
          </View>

          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#60a5fa" />
              <Text style={styles.loadingText}>Loading the assistant...</Text>
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <ScrollView ref={messagesScrollRef} style={styles.messagesScroll} contentContainerStyle={styles.messageList}>
            {(selectedChat?.messages ?? []).map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {!selectedChat?.messages.length && !loading ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateTitle}>Start the thread</Text>
                <Text style={styles.emptyStateBody}>
                  Messages now persist on the backend, so you can come back later and resume the full conversation.
                </Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={styles.composerCard}>
            {selectedChat?.draftAttachments.length ? (
              <View style={styles.draftAttachmentList}>
                {selectedChat.draftAttachments.map((attachment) => (
                  <View key={attachment.id} style={styles.draftAttachmentChip}>
                    <View style={styles.draftAttachmentMeta}>
                      <Text style={styles.draftAttachmentText}>{attachment.name}</Text>
                      <Text style={styles.draftAttachmentStatus}>
                        {attachment.scope === 'knowledge'
                          ? attachment.knowledgeStatus === 'pending'
                            ? 'Project knowledge syncing...'
                            : attachment.knowledgeStatus === 'indexed'
                              ? 'Project knowledge indexed'
                              : attachment.knowledgeStatus === 'failed'
                                ? 'Knowledge sync failed'
                                : 'Project knowledge'
                          : 'Thread-only'}
                      </Text>
                    </View>
                    <View style={styles.draftAttachmentActions}>
                      {selectedChat.projectId && attachment.scope !== 'knowledge' ? (
                        <Pressable
                          onPress={() => {
                            void handlePromoteAttachment(attachment.id);
                          }}
                          disabled={promotingAttachmentId === attachment.id}
                        >
                          <Text style={styles.draftAttachmentAction}>
                            {promotingAttachmentId === attachment.id ? 'Promoting...' : 'Add to knowledge'}
                          </Text>
                        </Pressable>
                      ) : null}
                      <Pressable onPress={() => handleRemoveAttachment(attachment.id)}>
                        <Text style={styles.draftAttachmentRemove}>×</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={selectedChat?.projectName ? `Ask about ${selectedChat.projectName}...` : 'Ask anything...'}
              placeholderTextColor="#64748b"
              multiline
              blurOnSubmit
              onSubmitEditing={() => {
                void handleSend();
              }}
              returnKeyType="send"
              enablesReturnKeyAutomatically
              style={styles.composerInput}
            />
            <View style={styles.composerFooter}>
              <View style={styles.composerMeta}>
                <View style={styles.composerTools}>
                  <Pressable
                    style={[styles.inlineModelButton, uploadingAttachment && styles.disabledButton]}
                    onPress={() => {
                      void handleAddAttachment();
                    }}
                    disabled={uploadingAttachment}
                  >
                    <Text style={styles.inlineModelButtonText}>
                      {uploadingAttachment ? 'Uploading...' : 'Attach file'}
                    </Text>
                  </Pressable>
                  <Pressable style={styles.inlineModelButton} onPress={() => setModelPickerVisible(true)}>
                    <Text style={styles.inlineModelButtonText}>{selectedModel?.name ?? 'Choose model'}</Text>
                    <Text style={styles.modelPillChevron}>▾</Text>
                  </Pressable>
                </View>
                <Text style={styles.helperText}>Files stay thread-local unless you promote them to project knowledge.</Text>
              </View>
              <Pressable
                style={[
                  styles.primaryButton,
                  styles.sendButton,
                  (Boolean(streamingChatId) || !draft.trim()) && styles.disabledButton,
                ]}
                onPress={() => {
                  void handleSend();
                }}
                disabled={Boolean(streamingChatId) || !draft.trim()}
              >
                <Text style={styles.primaryButtonText}>{streamingChatId ? 'Streaming...' : 'Send'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>

      <Modal animationType="fade" transparent visible={settingsVisible} onRequestClose={() => setSettingsVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Settings</Text>
            <Text style={styles.modalBody}>Signed in as @{session.user.login}</Text>
            <Text style={styles.modalBody}>
              API: {activeApiUrl}
              {health?.ragflowConfigured ? ' · RagFlow connected' : ' · RagFlow not configured'}
            </Text>
            <Text style={styles.modalBody}>Remote access: {remoteAccessLabel}</Text>
            <View style={styles.modalActions}>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => {
                  setSettingsVisible(false);
                  openConnectionSettings();
                }}
              >
                <Text style={styles.secondaryButtonText}>Connection</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => setSettingsVisible(false)}>
                <Text style={styles.secondaryButtonText}>Close</Text>
              </Pressable>
              <Pressable
                style={styles.primaryButton}
                onPress={() => {
                  setSettingsVisible(false);
                  void signOut();
                }}
              >
                <Text style={styles.primaryButtonText}>Sign out</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        transparent
        visible={connectionSettingsVisible}
        onRequestClose={() => setConnectionSettingsVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.sheetCard}>
            <Text style={styles.modalTitle}>Connection</Text>
            <Text style={styles.modalBody}>
              Point this frontend at your own daemon service. For GitHub Pages or any hosted frontend, use your daemon's
              Tailscale HTTPS URL.
            </Text>
            <Text style={styles.modalLabel}>Daemon URL</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://your-mac.tailnet.ts.net"
              placeholderTextColor="#64748b"
              value={apiUrlInput}
              onChangeText={setApiUrlInput}
              style={styles.modalInput}
            />
            <Text style={styles.helperText}>Default: {getDefaultApiUrl()}</Text>
            <Text style={styles.helperText}>LAN example: http://192.168.x.y:4000</Text>
            <Text style={styles.helperText}>Tailscale example: https://your-mac.tailnet.ts.net</Text>
            {suggestedApiUrl ? <Text style={styles.helperText}>Suggested by daemon: {suggestedApiUrl}</Text> : null}
            {savedApiUrlOverride ? <Text style={styles.helperText}>Saved override active</Text> : null}
            <View style={styles.modalActions}>
              {suggestedApiUrl ? (
                <Pressable
                  style={[styles.secondaryButton, savingConnection && styles.disabledButton]}
                  onPress={() => setApiUrlInput(suggestedApiUrl)}
                  disabled={savingConnection}
                >
                  <Text style={styles.secondaryButtonText}>Use suggested URL</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={[styles.secondaryButton, savingConnection && styles.disabledButton]}
                onPress={() => {
                  setConnectionSettingsVisible(false);
                }}
                disabled={savingConnection}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.secondaryButton, savingConnection && styles.disabledButton]}
                onPress={() => {
                  void handleResetConnection();
                }}
                disabled={savingConnection}
              >
                <Text style={styles.secondaryButtonText}>Use default</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryButton, savingConnection && styles.disabledButton]}
                onPress={() => {
                  void handleSaveConnection();
                }}
                disabled={savingConnection}
              >
                <Text style={styles.primaryButtonText}>{savingConnection ? 'Saving...' : 'Save'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal animationType="fade" transparent visible={modelPickerVisible} onRequestClose={() => setModelPickerVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheetCard}>
            <Text style={styles.modalTitle}>Choose model</Text>
            <Text style={styles.sheetSubtitle}>Pick the model for this chat.</Text>
            <ScrollView style={styles.modelList} contentContainerStyle={styles.modelListContent}>
              {models.map((model) => {
                const active = model.id === selectedChat?.model;
                return (
                  <Pressable
                    key={model.id}
                    style={[styles.modelOption, active && styles.modelOptionActive]}
                    onPress={() => handleSelectModel(model.id)}
                  >
                    <View style={styles.modelOptionText}>
                      <Text style={styles.modelOptionTitle}>{model.name}</Text>
                      <Text style={styles.modelOptionMeta}>
                        {model.supportsReasoning ? 'Supports reasoning' : 'Standard chat model'}
                      </Text>
                    </View>
                    {active ? <Text style={styles.modelOptionCheck}>✓</Text> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.modalActions}>
              <Pressable style={styles.secondaryButton} onPress={() => setModelPickerVisible(false)}>
                <Text style={styles.secondaryButtonText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    flexDirection: 'row',
    gap: 16,
  },
  shellCompact: {
    flexDirection: 'column',
  },
  centeredLayout: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signInCard: {
    width: '100%',
    maxWidth: 560,
    backgroundColor: '#111827',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#263154',
    padding: 24,
    gap: 16,
  },
  eyebrow: {
    color: '#60a5fa',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    fontSize: 12,
    fontWeight: '700',
  },
  signInTitle: {
    color: '#f8fafc',
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '800',
  },
  signInBody: {
    color: '#cbd5e1',
    fontSize: 16,
    lineHeight: 24,
  },
  sidebar: {
    width: 300,
    backgroundColor: '#0f172a',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 16,
    gap: 16,
  },
  sidebarCompact: {
    width: '100%',
  },
  sidebarHeader: {
    gap: 4,
  },
  sidebarTitle: {
    color: '#f8fafc',
    fontSize: 19,
    fontWeight: '800',
  },
  sidebarSubtitle: {
    color: '#94a3b8',
    fontSize: 13,
  },
  sidebarScroll: {
    flex: 1,
  },
  sidebarContent: {
    gap: 18,
    paddingBottom: 16,
  },
  section: {
    gap: 12,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sectionHint: {
    color: '#64748b',
    fontSize: 12,
  },
  sidebarList: {
    gap: 10,
  },
  sidebarItem: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1f2b46',
    backgroundColor: '#111827',
    padding: 14,
    gap: 4,
  },
  sidebarItemActive: {
    borderColor: '#60a5fa',
    backgroundColor: '#162038',
  },
  sidebarItemTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
  },
  sidebarItemMeta: {
    color: '#94a3b8',
    fontSize: 13,
  },
  createProjectCard: {
    gap: 10,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1f2b46',
    backgroundColor: '#111827',
  },
  sidebarInput: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#263154',
    backgroundColor: '#020617',
    color: '#f8fafc',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  mainPanel: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 18,
    gap: 16,
    minHeight: 0,
  },
  mainHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  mainHeaderText: {
    flex: 1,
    gap: 6,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  chatTitle: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '800',
  },
  chatSubtitle: {
    color: '#94a3b8',
    fontSize: 14,
  },
  modelPillButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#0f172a',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  modelPillText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
  modelPillChevron: {
    color: '#94a3b8',
    fontSize: 12,
  },
  settingsButton: {
    width: 42,
    height: 42,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f172a',
  },
  settingsButtonText: {
    color: '#f8fafc',
    fontSize: 20,
  },
  messagesScroll: {
    flex: 1,
    minHeight: 0,
  },
  messageList: {
    gap: 14,
    paddingBottom: 12,
  },
  emptyState: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1f2b46',
    backgroundColor: '#0f172a',
    padding: 18,
    gap: 8,
  },
  emptyStateTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  emptyStateBody: {
    color: '#94a3b8',
    lineHeight: 20,
  },
  composerCard: {
    gap: 12,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#1f2937',
    backgroundColor: '#0b1120',
    padding: 14,
  },
  composerInput: {
    minHeight: 92,
    maxHeight: 220,
    color: '#f8fafc',
    fontSize: 15,
    lineHeight: 22,
    textAlignVertical: 'top',
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  composerFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: 12,
  },
  composerMeta: {
    flex: 1,
    gap: 8,
  },
  composerTools: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  inlineModelButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#111827',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  inlineModelButtonText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
  helperText: {
    color: '#64748b',
    fontSize: 12,
  },
  draftAttachmentList: {
    flexDirection: 'column',
    gap: 8,
  },
  draftAttachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#111827',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  draftAttachmentMeta: {
    flex: 1,
    gap: 4,
  },
  draftAttachmentText: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
  },
  draftAttachmentStatus: {
    color: '#94a3b8',
    fontSize: 11,
  },
  draftAttachmentActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  draftAttachmentAction: {
    color: '#93c5fd',
    fontSize: 12,
    fontWeight: '700',
  },
  draftAttachmentRemove: {
    color: '#94a3b8',
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 16,
  },
  sendButton: {
    minWidth: 112,
  },
  primaryButton: {
    borderRadius: 14,
    backgroundColor: '#2563eb',
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newChatButton: {
    borderRadius: 14,
    backgroundColor: '#2563eb',
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#0f172a',
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.6,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  loadingText: {
    color: '#cbd5e1',
  },
  errorCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    backgroundColor: '#371515',
    padding: 14,
  },
  errorText: {
    color: '#fecaca',
    fontSize: 14,
  },
  deviceAuthCard: {
    backgroundColor: '#141b34',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#263154',
    padding: 18,
    gap: 10,
  },
  deviceAuthLabel: {
    color: '#94a3b8',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  deviceAuthCode: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 2,
  },
  deviceAuthBody: {
    color: '#cbd5e1',
    lineHeight: 22,
  },
  deviceAuthLink: {
    color: '#93c5fd',
    fontWeight: '700',
  },
  deviceAuthMeta: {
    color: '#94a3b8',
    fontSize: 12,
  },
  configHint: {
    backgroundColor: '#221a12',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#7c5b19',
    padding: 16,
    gap: 8,
  },
  configHintTitle: {
    color: '#fef3c7',
    fontSize: 16,
    fontWeight: '700',
  },
  configHintBody: {
    color: '#fde68a',
    fontSize: 14,
    lineHeight: 20,
  },
  configHintCode: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#111827',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#263154',
    padding: 20,
    gap: 16,
  },
  sheetCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#111827',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#263154',
    padding: 20,
    gap: 16,
  },
  modalTitle: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '800',
  },
  modalBody: {
    color: '#cbd5e1',
    fontSize: 15,
  },
  modalLabel: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  modalInput: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#263154',
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  sheetSubtitle: {
    color: '#94a3b8',
    fontSize: 14,
  },
  modelList: {
    maxHeight: 320,
  },
  modelListContent: {
    gap: 10,
  },
  modelOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#263154',
    backgroundColor: '#0f172a',
    padding: 14,
  },
  modelOptionActive: {
    borderColor: '#60a5fa',
    backgroundColor: '#162038',
  },
  modelOptionText: {
    flex: 1,
    gap: 4,
  },
  modelOptionTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
  },
  modelOptionMeta: {
    color: '#94a3b8',
    fontSize: 13,
  },
  modelOptionCheck: {
    color: '#60a5fa',
    fontSize: 18,
    fontWeight: '800',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
});
