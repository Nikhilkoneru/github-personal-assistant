import { useSyncExternalStore } from 'react';
import { createStore } from 'https://esm.sh/zustand@5.0.8/vanilla?target=es2022';

import type { CanvasArtifact, CanvasSelection } from './types.js';

export type CanvasEditorSessionState = {
  draftContent: string | null;
  selection: CanvasSelection | null;
  selectionPromptDraft: string;
  pendingRemoteApply: boolean;
};

export type ThreadCanvasWorkspaceState = {
  canvases: CanvasArtifact[];
  activeCanvasId: string | null;
  isPaneOpen: boolean;
  editorSessions: Record<string, CanvasEditorSessionState>;
};

export type WorkspacePaneMode = 'chat' | 'split' | 'canvas';

type CanvasSyncPayload = {
  canvases: CanvasArtifact[];
  activeCanvasId?: string | null;
  open?: boolean;
};

type WorkspaceStore = {
  selectedChatId: string | null;
  composerDraft: string;
  isNarrowViewport: boolean;
  threads: Record<string, ThreadCanvasWorkspaceState>;
  setSelectedChatId: (chatId: string | null) => void;
  setComposerDraft: (draft: string) => void;
  setIsNarrowViewport: (isNarrow: boolean) => void;
  resetWorkspace: () => void;
  replaceThreadCanvases: (threadId: string, canvases: CanvasArtifact[]) => void;
  upsertCanvasForThread: (threadId: string, canvas: CanvasArtifact) => void;
  patchCanvasForThread: (
    threadId: string,
    canvasId: string,
    patch: Partial<Pick<CanvasArtifact, 'title' | 'content' | 'updatedAt'>>,
  ) => void;
  applyCanvasSync: (threadId: string, payload: CanvasSyncPayload) => void;
  openCanvas: (threadId: string, canvasId?: string | null) => void;
  closeCanvas: (threadId: string) => void;
  setActiveCanvas: (threadId: string, canvasId: string | null) => void;
  setCanvasDraft: (threadId: string, canvasId: string, content: string) => void;
  setCanvasSelection: (threadId: string, canvasId: string, selection: CanvasSelection | null) => void;
  setSelectionPromptDraft: (threadId: string, canvasId: string, draft: string) => void;
  clearCanvasSelection: (threadId: string, canvasId: string) => void;
  setCanvasPendingRemoteApply: (threadId: string, canvasId: string, pending: boolean) => void;
};

export const INITIAL_CANVAS_EDITOR_SESSION_STATE: Readonly<CanvasEditorSessionState> = Object.freeze({
  draftContent: null,
  selection: null,
  selectionPromptDraft: '',
  pendingRemoteApply: false,
});

const createCanvasEditorSessionState = (): CanvasEditorSessionState => ({
  draftContent: null,
  selection: null,
  selectionPromptDraft: '',
  pendingRemoteApply: false,
});

export const INITIAL_THREAD_CANVAS_STATE: Readonly<ThreadCanvasWorkspaceState> = Object.freeze({
  canvases: [],
  activeCanvasId: null,
  isPaneOpen: false,
  editorSessions: {},
});

const createThreadCanvasState = (): ThreadCanvasWorkspaceState => ({
  canvases: [],
  activeCanvasId: null,
  isPaneOpen: false,
  editorSessions: {},
});

const mergeCanvasOrder = (currentCanvases: CanvasArtifact[], incomingCanvases: CanvasArtifact[]) => {
  const incomingById = new Map(incomingCanvases.map((canvas) => [canvas.id, canvas]));
  const currentIds = new Set(currentCanvases.map((canvas) => canvas.id));
  const preservedCanvases = currentCanvases.flatMap((canvas) => {
    const nextCanvas = incomingById.get(canvas.id);
    return nextCanvas ? [nextCanvas] : [];
  });
  const newCanvases = incomingCanvases.filter((canvas) => !currentIds.has(canvas.id));
  return [...newCanvases, ...preservedCanvases];
};

const resolveActiveCanvasId = (
  canvases: CanvasArtifact[],
  existingActiveCanvasId: string | null,
  requestedActiveCanvasId?: string | null,
) => {
  if (canvases.length === 0) {
    return null;
  }

  if (requestedActiveCanvasId && canvases.some((canvas) => canvas.id === requestedActiveCanvasId)) {
    return requestedActiveCanvasId;
  }

  if (existingActiveCanvasId && canvases.some((canvas) => canvas.id === existingActiveCanvasId)) {
    return existingActiveCanvasId;
  }

  return canvases[0]?.id ?? null;
};

const updateThreadState = (
  threads: Record<string, ThreadCanvasWorkspaceState>,
  threadId: string,
  updater: (current: ThreadCanvasWorkspaceState) => ThreadCanvasWorkspaceState,
) => {
  const current = threads[threadId] ?? createThreadCanvasState();
  return {
    ...threads,
    [threadId]: updater(current),
  };
};

const normalizeEditorSessions = (
  currentSessions: Record<string, CanvasEditorSessionState>,
  canvases: CanvasArtifact[],
  options?: {
    consumePendingRemoteApply?: boolean;
  },
) => {
  const consumePendingRemoteApply = options?.consumePendingRemoteApply ?? false;
  return Object.fromEntries(
    canvases.map((canvas) => {
      const current = currentSessions[canvas.id] ?? createCanvasEditorSessionState();

      if (consumePendingRemoteApply && current.pendingRemoteApply) {
        return [canvas.id, createCanvasEditorSessionState()];
      }

      return [
        canvas.id,
        {
          ...current,
          draftContent: current.draftContent === canvas.content ? null : current.draftContent,
          pendingRemoteApply: consumePendingRemoteApply ? false : current.pendingRemoteApply,
        },
      ];
    }),
  );
};

const nextThreadState = (
  current: ThreadCanvasWorkspaceState,
  canvases: CanvasArtifact[],
  activeCanvasId: string | null,
  isPaneOpen: boolean,
  options?: {
    consumePendingRemoteApply?: boolean;
  },
): ThreadCanvasWorkspaceState => ({
  canvases,
  activeCanvasId,
  isPaneOpen: canvases.length > 0 ? isPaneOpen : false,
  editorSessions: normalizeEditorSessions(current.editorSessions, canvases, options),
});

export const getThreadCanvasState = (
  state: Pick<WorkspaceStore, 'threads'>,
  threadId: string | null | undefined,
): ThreadCanvasWorkspaceState => {
  if (!threadId) {
    return INITIAL_THREAD_CANVAS_STATE;
  }
  return state.threads[threadId] ?? INITIAL_THREAD_CANVAS_STATE;
};

export const getWorkspacePaneMode = (
  state: Pick<WorkspaceStore, 'threads' | 'isNarrowViewport'>,
  threadId: string | null | undefined,
): WorkspacePaneMode => {
  const threadState = getThreadCanvasState(state, threadId);
  if (!threadState.isPaneOpen) {
    return 'chat';
  }
  return state.isNarrowViewport ? 'canvas' : 'split';
};

const workspaceStore = createStore<WorkspaceStore>()((set) => ({
  selectedChatId: null,
  composerDraft: '',
  isNarrowViewport: false,
  threads: {},
  setSelectedChatId: (chatId) => set({ selectedChatId: chatId }),
  setComposerDraft: (draft) => set({ composerDraft: draft }),
  setIsNarrowViewport: (isNarrow) => set({ isNarrowViewport: isNarrow }),
  resetWorkspace: () =>
    set((state) => ({
      selectedChatId: null,
      composerDraft: '',
      threads: {},
      isNarrowViewport: state.isNarrowViewport,
    })),
  replaceThreadCanvases: (threadId, incomingCanvases) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const canvases = mergeCanvasOrder(current.canvases, incomingCanvases);
        const activeCanvasId = resolveActiveCanvasId(canvases, current.activeCanvasId);
        return nextThreadState(current, canvases, activeCanvasId, current.isPaneOpen);
      }),
    })),
  upsertCanvasForThread: (threadId, canvas) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const canvases = current.canvases.some((item) => item.id === canvas.id)
          ? current.canvases.map((item) => (item.id === canvas.id ? canvas : item))
          : [canvas, ...current.canvases];
        const activeCanvasId = resolveActiveCanvasId(canvases, current.activeCanvasId, canvas.id);
        return nextThreadState(current, canvases, activeCanvasId, current.isPaneOpen || current.canvases.length === 0);
      }),
    })),
  patchCanvasForThread: (threadId, canvasId, patch) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const canvases = current.canvases.map((canvas) => (canvas.id === canvasId ? { ...canvas, ...patch } : canvas));
        const activeCanvasId = resolveActiveCanvasId(canvases, current.activeCanvasId);
        return nextThreadState(current, canvases, activeCanvasId, current.isPaneOpen);
      }),
    })),
  applyCanvasSync: (threadId, payload) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const canvases = mergeCanvasOrder(current.canvases, payload.canvases);
        const activeCanvasId = resolveActiveCanvasId(canvases, current.activeCanvasId, payload.activeCanvasId);
        const isPaneOpen = payload.open ?? current.isPaneOpen;
        return nextThreadState(current, canvases, activeCanvasId, isPaneOpen, {
          consumePendingRemoteApply: true,
        });
      }),
    })),
  openCanvas: (threadId, requestedCanvasId) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const activeCanvasId = resolveActiveCanvasId(current.canvases, current.activeCanvasId, requestedCanvasId);
        return nextThreadState(current, current.canvases, activeCanvasId, true);
      }),
    })),
  closeCanvas: (threadId) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        if (!current.activeCanvasId) {
          return nextThreadState(current, current.canvases, current.activeCanvasId, false);
        }

        return {
          ...nextThreadState(current, current.canvases, current.activeCanvasId, false),
          editorSessions: {
            ...normalizeEditorSessions(current.editorSessions, current.canvases),
            [current.activeCanvasId]: {
              ...(current.editorSessions[current.activeCanvasId] ?? createCanvasEditorSessionState()),
              selection: null,
              selectionPromptDraft: '',
            },
          },
        };
      }),
    })),
  setActiveCanvas: (threadId, canvasId) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const activeCanvasId = resolveActiveCanvasId(current.canvases, current.activeCanvasId, canvasId);
        return nextThreadState(current, current.canvases, activeCanvasId, current.isPaneOpen);
      }),
    })),
  setCanvasDraft: (threadId, canvasId, content) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => ({
        ...current,
        editorSessions: {
          ...normalizeEditorSessions(current.editorSessions, current.canvases),
          [canvasId]: {
            ...(current.editorSessions[canvasId] ?? createCanvasEditorSessionState()),
            draftContent: content,
            pendingRemoteApply: false,
          },
        },
      })),
    })),
  setCanvasSelection: (threadId, canvasId, selection) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => ({
        ...current,
        editorSessions: {
          ...normalizeEditorSessions(current.editorSessions, current.canvases),
          [canvasId]: {
            ...(current.editorSessions[canvasId] ?? createCanvasEditorSessionState()),
            selection,
            selectionPromptDraft: selection
              ? (current.editorSessions[canvasId] ?? INITIAL_CANVAS_EDITOR_SESSION_STATE).selectionPromptDraft
              : '',
          },
        },
      })),
    })),
  setSelectionPromptDraft: (threadId, canvasId, draft) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => ({
        ...current,
        editorSessions: {
          ...normalizeEditorSessions(current.editorSessions, current.canvases),
          [canvasId]: {
            ...(current.editorSessions[canvasId] ?? createCanvasEditorSessionState()),
            selectionPromptDraft: draft,
          },
        },
      })),
    })),
  clearCanvasSelection: (threadId, canvasId) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => ({
        ...current,
        editorSessions: {
          ...normalizeEditorSessions(current.editorSessions, current.canvases),
          [canvasId]: {
            ...(current.editorSessions[canvasId] ?? createCanvasEditorSessionState()),
            selection: null,
            selectionPromptDraft: '',
          },
        },
      })),
    })),
  setCanvasPendingRemoteApply: (threadId, canvasId, pending) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => ({
        ...current,
        editorSessions: {
          ...normalizeEditorSessions(current.editorSessions, current.canvases),
          [canvasId]: {
            ...(current.editorSessions[canvasId] ?? createCanvasEditorSessionState()),
            pendingRemoteApply: pending,
          },
        },
      })),
    })),
}));

export const useWorkspaceStore = <T,>(selector: (state: WorkspaceStore) => T) =>
  useSyncExternalStore(
    workspaceStore.subscribe,
    () => selector(workspaceStore.getState()),
    () => selector(workspaceStore.getState()),
  );
