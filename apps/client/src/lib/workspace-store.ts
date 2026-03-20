import { useSyncExternalStore } from 'react';
import { createStore } from 'https://esm.sh/zustand@5.0.8/vanilla?target=es2022';

import type { CanvasArtifact, CanvasSelection } from './types.js';

export type CanvasPresentationMode = 'preview' | 'edit';

export type CanvasEditorSessionState = {
  draftContent: string | null;
  selection: CanvasSelection | null;
  selectionPromptDraft: string;
  pendingRemoteApply: boolean;
  presentationMode: CanvasPresentationMode;
};

export type ThreadCanvasWorkspaceState = {
  canvases: CanvasArtifact[];
  activeCanvasId: string | null;
  isPaneOpen: boolean;
  manualPaneCloseCanvasIds: string[] | null;
  editorSessions: Record<string, CanvasEditorSessionState>;
};

export type WorkspacePaneMode = 'chat' | 'split' | 'canvas';

type CanvasSyncPayload = {
  canvases: CanvasArtifact[];
  activeCanvasId?: string | null;
  open?: boolean;
};

type UpsertCanvasOptions = {
  activate?: boolean;
  preservePaneState?: boolean;
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
  upsertCanvasForThread: (threadId: string, canvas: CanvasArtifact, options?: UpsertCanvasOptions) => void;
  patchCanvasForThread: (
    threadId: string,
    canvasId: string,
    patch: Partial<Pick<CanvasArtifact, 'title' | 'content' | 'updatedAt'>>,
  ) => void;
  applyCanvasSync: (threadId: string, payload: CanvasSyncPayload) => void;
  allowRemoteCanvasOpen: (threadId: string) => void;
  openCanvas: (threadId: string, canvasId?: string | null) => void;
  closeCanvas: (threadId: string) => void;
  setActiveCanvas: (threadId: string, canvasId: string | null) => void;
  setCanvasDraft: (threadId: string, canvasId: string, content: string) => void;
  setCanvasSelection: (threadId: string, canvasId: string, selection: CanvasSelection | null) => void;
  setSelectionPromptDraft: (threadId: string, canvasId: string, draft: string) => void;
  clearCanvasSelection: (threadId: string, canvasId: string) => void;
  setCanvasPendingRemoteApply: (threadId: string, canvasId: string, pending: boolean) => void;
  setCanvasPresentationMode: (threadId: string, canvasId: string, mode: CanvasPresentationMode) => void;
};

export const INITIAL_CANVAS_EDITOR_SESSION_STATE: Readonly<CanvasEditorSessionState> = Object.freeze({
  draftContent: null,
  selection: null,
  selectionPromptDraft: '',
  pendingRemoteApply: false,
  presentationMode: 'preview',
});

const createCanvasEditorSessionState = (
  presentationMode: CanvasPresentationMode = 'preview',
): CanvasEditorSessionState => ({
  draftContent: null,
  selection: null,
  selectionPromptDraft: '',
  pendingRemoteApply: false,
  presentationMode,
});

export const INITIAL_THREAD_CANVAS_STATE: Readonly<ThreadCanvasWorkspaceState> = Object.freeze({
  canvases: [],
  activeCanvasId: null,
  isPaneOpen: false,
  manualPaneCloseCanvasIds: null,
  editorSessions: {},
});

const createThreadCanvasState = (): ThreadCanvasWorkspaceState => ({
  canvases: [],
  activeCanvasId: null,
  isPaneOpen: false,
  manualPaneCloseCanvasIds: null,
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

const defaultCanvasPresentationMode = (kind: CanvasArtifact['kind']) =>
  kind === 'code' ? 'edit' : 'preview';

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
    contentResetCanvasIds?: ReadonlySet<string>;
    previewCanvasIds?: ReadonlySet<string>;
  },
) => {
  const consumePendingRemoteApply = options?.consumePendingRemoteApply ?? false;
  return Object.fromEntries(
    canvases.map((canvas) => {
      const current =
        currentSessions[canvas.id] ?? createCanvasEditorSessionState(defaultCanvasPresentationMode(canvas.kind));
      const shouldResetContentState = options?.contentResetCanvasIds?.has(canvas.id) ?? false;
      const shouldPreviewCanvas =
        canvas.kind !== 'code' && (options?.previewCanvasIds?.has(canvas.id) ?? false);

      if (consumePendingRemoteApply && current.pendingRemoteApply) {
        return [canvas.id, createCanvasEditorSessionState(defaultCanvasPresentationMode(canvas.kind))];
      }

      const draftContent = shouldResetContentState ? null : current.draftContent === canvas.content ? null : current.draftContent;
      const visibleContent = draftContent ?? canvas.content;
      const hasValidSelection =
        current.selection !== null &&
        current.selection.start >= 0 &&
        current.selection.end <= visibleContent.length &&
        current.selection.start < current.selection.end &&
        visibleContent.slice(current.selection.start, current.selection.end) === current.selection.text;

      return [
        canvas.id,
        {
          ...current,
          draftContent,
          selection: hasValidSelection ? current.selection : null,
          selectionPromptDraft: hasValidSelection ? current.selectionPromptDraft : '',
          pendingRemoteApply: consumePendingRemoteApply ? false : current.pendingRemoteApply,
          presentationMode:
            canvas.kind === 'code'
              ? 'edit'
              : shouldPreviewCanvas && current.presentationMode !== 'edit'
                ? 'preview'
                : current.presentationMode,
        },
      ];
    }),
  );
};

const getContentResetCanvasIds = (currentCanvases: CanvasArtifact[], nextCanvases: CanvasArtifact[]) => {
  const currentById = new Map(currentCanvases.map((canvas) => [canvas.id, canvas]));
  return new Set(
    nextCanvases.flatMap((canvas) => {
      const current = currentById.get(canvas.id);
      return current && current.content !== canvas.content ? [canvas.id] : [];
    }),
  );
};

const getPreviewCanvasIds = (currentCanvases: CanvasArtifact[], nextCanvases: CanvasArtifact[]) => {
  const currentById = new Map(currentCanvases.map((canvas) => [canvas.id, canvas]));
  return new Set(
    nextCanvases.flatMap((canvas) => {
      if (canvas.kind === 'code') {
        return [];
      }

      const current = currentById.get(canvas.id);
      return !current || current.content !== canvas.content ? [canvas.id] : [];
    }),
  );
};

const hasCanvasOutsideSnapshot = (canvases: CanvasArtifact[], snapshotIds: string[] | null) => {
  if (snapshotIds === null) {
    return false;
  }

  const snapshotIdSet = new Set(snapshotIds);
  return canvases.some((canvas) => !snapshotIdSet.has(canvas.id));
};

const nextThreadState = (
  current: ThreadCanvasWorkspaceState,
  canvases: CanvasArtifact[],
  activeCanvasId: string | null,
  isPaneOpen: boolean,
  options?: {
    consumePendingRemoteApply?: boolean;
    contentResetCanvasIds?: ReadonlySet<string>;
    manualPaneCloseCanvasIds?: string[] | null;
    previewCanvasIds?: ReadonlySet<string>;
  },
): ThreadCanvasWorkspaceState => ({
  canvases,
  activeCanvasId,
  isPaneOpen: canvases.length > 0 ? isPaneOpen : false,
  manualPaneCloseCanvasIds: canvases.length > 0 ? (options?.manualPaneCloseCanvasIds ?? current.manualPaneCloseCanvasIds) : null,
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
  setSelectedChatId: (chatId) =>
    set((state) => ({
      selectedChatId: chatId,
      composerDraft: state.selectedChatId === chatId ? state.composerDraft : '',
    })),
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
        return nextThreadState(current, canvases, activeCanvasId, current.isPaneOpen, {
          contentResetCanvasIds: getContentResetCanvasIds(current.canvases, incomingCanvases),
          previewCanvasIds: getPreviewCanvasIds(current.canvases, incomingCanvases),
        });
      }),
    })),
  upsertCanvasForThread: (threadId, canvas, options) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const canvases = current.canvases.some((item) => item.id === canvas.id)
          ? current.canvases.map((item) => (item.id === canvas.id ? canvas : item))
          : [canvas, ...current.canvases];
        const activeCanvasId = resolveActiveCanvasId(
          canvases,
          current.activeCanvasId,
          options?.activate === false ? undefined : canvas.id,
        );
        return nextThreadState(
          current,
          canvases,
          activeCanvasId,
          options?.preservePaneState ? current.isPaneOpen : current.isPaneOpen || current.canvases.length === 0,
        );
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
        const shouldHonorRemoteOpen =
          payload.open !== true ||
          current.manualPaneCloseCanvasIds === null ||
          hasCanvasOutsideSnapshot(payload.canvases, current.manualPaneCloseCanvasIds);
        const activeCanvasId = resolveActiveCanvasId(
          canvases,
          current.activeCanvasId,
          payload.open === true && !shouldHonorRemoteOpen ? undefined : payload.activeCanvasId,
        );
        const isPaneOpen =
          payload.open === undefined ? current.isPaneOpen : payload.open ? (shouldHonorRemoteOpen ? true : current.isPaneOpen) : false;
        return nextThreadState(current, canvases, activeCanvasId, isPaneOpen, {
          consumePendingRemoteApply: true,
          contentResetCanvasIds: getContentResetCanvasIds(current.canvases, payload.canvases),
          manualPaneCloseCanvasIds: payload.open === true && shouldHonorRemoteOpen ? null : current.manualPaneCloseCanvasIds,
          previewCanvasIds: getPreviewCanvasIds(current.canvases, payload.canvases),
        });
      }),
    })),
  allowRemoteCanvasOpen: (threadId) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) =>
        current.manualPaneCloseCanvasIds === null
          ? current
          : nextThreadState(current, current.canvases, current.activeCanvasId, current.isPaneOpen, {
              manualPaneCloseCanvasIds: null,
            }),
      ),
    })),
  openCanvas: (threadId, requestedCanvasId) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const activeCanvasId = resolveActiveCanvasId(current.canvases, current.activeCanvasId, requestedCanvasId);
        return nextThreadState(current, current.canvases, activeCanvasId, true, {
          manualPaneCloseCanvasIds: null,
        });
      }),
    })),
  closeCanvas: (threadId) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const manualPaneCloseCanvasIds = current.canvases.map((canvas) => canvas.id);
        if (!current.activeCanvasId) {
          return nextThreadState(current, current.canvases, current.activeCanvasId, false, {
            manualPaneCloseCanvasIds,
          });
        }

        return {
          ...nextThreadState(current, current.canvases, current.activeCanvasId, false, {
            manualPaneCloseCanvasIds,
          }),
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
  setCanvasPresentationMode: (threadId, canvasId, mode) =>
    set((state) => ({
      threads: updateThreadState(state.threads, threadId, (current) => {
        const canvas = current.canvases.find((item) => item.id === canvasId);
        const nextMode = canvas?.kind === 'code' ? 'edit' : mode;
        return {
          ...current,
          editorSessions: {
            ...normalizeEditorSessions(current.editorSessions, current.canvases),
            [canvasId]: {
              ...(current.editorSessions[canvasId] ??
                createCanvasEditorSessionState(
                  canvas ? defaultCanvasPresentationMode(canvas.kind) : 'preview',
                )),
              presentationMode: nextMode,
            },
          },
        };
      }),
    })),
}));

export const useWorkspaceStore = <T,>(selector: (state: WorkspaceStore) => T) =>
  useSyncExternalStore(
    workspaceStore.subscribe,
    () => selector(workspaceStore.getState()),
    () => selector(workspaceStore.getState()),
  );

export const getWorkspaceStoreState = () => workspaceStore.getState();
