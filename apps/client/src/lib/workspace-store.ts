import { useSyncExternalStore } from 'react';
import { createStore } from 'https://esm.sh/zustand@5.0.8/vanilla?target=es2022';

import type { CanvasArtifact, CanvasSelection } from './types.js';

export type ThreadCanvasWorkspaceState = {
  canvases: CanvasArtifact[];
  activeCanvasId: string | null;
  isPaneOpen: boolean;
  selection: CanvasSelection | null;
  selectionPromptDraft: string;
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
  setCanvasSelection: (threadId: string, selection: CanvasSelection | null) => void;
  setSelectionPromptDraft: (threadId: string, draft: string) => void;
  clearCanvasSelection: (threadId: string) => void;
};

const INITIAL_THREAD_CANVAS_STATE: ThreadCanvasWorkspaceState = Object.freeze({
  canvases: [],
  activeCanvasId: null,
  isPaneOpen: false,
  selection: null,
  selectionPromptDraft: '',
});

const createThreadCanvasState = (): ThreadCanvasWorkspaceState => ({
  canvases: [],
  activeCanvasId: null,
  isPaneOpen: false,
  selection: null,
  selectionPromptDraft: '',
});

const sortCanvases = (canvases: CanvasArtifact[]) => [...canvases].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

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

const nextThreadState = (
  current: ThreadCanvasWorkspaceState,
  canvases: CanvasArtifact[],
  activeCanvasId: string | null,
  isPaneOpen: boolean,
  options?: {
    clearTransient?: boolean;
  },
): ThreadCanvasWorkspaceState => {
  const shouldClearTransient = options?.clearTransient ?? false;
  return {
    canvases,
    activeCanvasId,
    isPaneOpen: canvases.length > 0 ? isPaneOpen : false,
    selection: shouldClearTransient ? null : current.selection,
    selectionPromptDraft: shouldClearTransient ? '' : current.selectionPromptDraft,
  };
};

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
        const canvases = sortCanvases(incomingCanvases);
        const activeCanvasId = resolveActiveCanvasId(canvases, current.activeCanvasId);
        return nextThreadState(current, canvases, activeCanvasId, current.isPaneOpen, {
          clearTransient: activeCanvasId !== current.activeCanvasId || canvases.length === 0,
        });
      }),
    })),
  upsertCanvasForThread: (threadId, canvas) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const canvases = sortCanvases(
          current.canvases.some((item) => item.id === canvas.id)
            ? current.canvases.map((item) => (item.id === canvas.id ? canvas : item))
            : [canvas, ...current.canvases],
        );
        const activeCanvasId = resolveActiveCanvasId(canvases, current.activeCanvasId, canvas.id);
        return nextThreadState(current, canvases, activeCanvasId, current.isPaneOpen || current.canvases.length === 0, {
          clearTransient: activeCanvasId !== current.activeCanvasId,
        });
      }),
    })),
  patchCanvasForThread: (threadId, canvasId, patch) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const canvases = sortCanvases(
          current.canvases.map((canvas) => (canvas.id === canvasId ? { ...canvas, ...patch } : canvas)),
        );
        const activeCanvasId = resolveActiveCanvasId(canvases, current.activeCanvasId);
        return nextThreadState(current, canvases, activeCanvasId, current.isPaneOpen);
      }),
    })),
  applyCanvasSync: (threadId, payload) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const canvases = sortCanvases(payload.canvases);
        const activeCanvasId = resolveActiveCanvasId(canvases, current.activeCanvasId, payload.activeCanvasId);
        const isPaneOpen = payload.open ?? current.isPaneOpen;
        return nextThreadState(current, canvases, activeCanvasId, isPaneOpen, {
          clearTransient: true,
        });
      }),
    })),
  openCanvas: (threadId, requestedCanvasId) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const activeCanvasId = resolveActiveCanvasId(current.canvases, current.activeCanvasId, requestedCanvasId);
        return nextThreadState(current, current.canvases, activeCanvasId, true, {
          clearTransient: requestedCanvasId !== undefined || !current.isPaneOpen,
        });
      }),
    })),
  closeCanvas: (threadId) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) =>
        nextThreadState(current, current.canvases, current.activeCanvasId, false, {
          clearTransient: true,
        }),
      ),
    })),
  setActiveCanvas: (threadId, canvasId) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const activeCanvasId = resolveActiveCanvasId(current.canvases, current.activeCanvasId, canvasId);
        return nextThreadState(current, current.canvases, activeCanvasId, current.isPaneOpen, {
          clearTransient: activeCanvasId !== current.activeCanvasId,
        });
      }),
    })),
  setCanvasSelection: (threadId, selection) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => ({
        ...current,
        selection,
        selectionPromptDraft: selection ? current.selectionPromptDraft : '',
      })),
    })),
  setSelectionPromptDraft: (threadId, draft) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => ({
        ...current,
        selectionPromptDraft: draft,
      })),
    })),
  clearCanvasSelection: (threadId) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => ({
        ...current,
        selection: null,
        selectionPromptDraft: '',
      })),
    })),
}));

export const useWorkspaceStore = <T,>(selector: (state: WorkspaceStore) => T) =>
  useSyncExternalStore(
    workspaceStore.subscribe,
    () => selector(workspaceStore.getState()),
    () => selector(workspaceStore.getState()),
  );
