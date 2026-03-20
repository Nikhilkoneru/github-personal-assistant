import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { drawSelection, EditorView } from '@codemirror/view';
import { minimalSetup } from 'codemirror';

import type { CanvasArtifact, CanvasSelection } from '../lib/types.js';

type CanvasEditorProps = {
  canvas: CanvasArtifact;
  content: string;
  selection: CanvasSelection | null;
  selectionPromptDraft: string;
  onContentChange: (content: string) => void;
  onSelectionChange: (selection: CanvasSelection | null) => void;
  onSelectionPromptChange: (value: string) => void;
  onSubmitSelectionPrompt: () => void;
  onClearSelection: () => void;
  selectionSubmitDisabled?: boolean;
};

type InlineComposerPosition = {
  left: number;
  top: number;
};

const INLINE_COMPOSER_MAX_WIDTH = 320;
const INLINE_COMPOSER_HEIGHT = 56;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const canvasEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
  },
  '.cm-scroller': {
    height: '100%',
    overflow: 'auto',
    fontFamily: 'inherit',
  },
  '.cm-content': {
    minHeight: '100%',
    boxSizing: 'border-box',
    padding: 'var(--canvas-editor-padding, 40px 56px 96px)',
    maxWidth: '720px',
    margin: '0 auto',
  },
  '.cm-line': {
    padding: '0',
  },
  '&.cm-focused': {
    outline: 'none',
  },
});

const getCanvasSelection = (state: EditorState): CanvasSelection | null => {
  const { main } = state.selection;
  if (main.empty) {
    return null;
  }

  const start = Math.min(main.from, main.to);
  const end = Math.max(main.from, main.to);
  return {
    start,
    end,
    text: state.doc.sliceString(start, end),
  };
};

const areSelectionsEqual = (left: CanvasSelection | null, right: CanvasSelection | null) =>
  left?.start === right?.start && left?.end === right?.end && left?.text === right?.text;

function SendSelectionIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4Z" />
    </svg>
  );
}

export function CanvasEditor({
  canvas,
  content,
  selection,
  selectionPromptDraft,
  onContentChange,
  onSelectionChange,
  onSelectionPromptChange,
  onSubmitSelectionPrompt,
  onClearSelection,
  selectionSubmitDisabled,
}: CanvasEditorProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const selectionComposerRef = useRef<HTMLDivElement>(null);
  const selectionPromptRef = useRef<HTMLInputElement>(null);
  const callbackRef = useRef({
    onContentChange,
    onSelectionChange,
  });
  const suppressEditorEventsRef = useRef(false);
  const lastSelectionRef = useRef<CanvasSelection | null>(selection);
  const [inlineComposerPosition, setInlineComposerPosition] = useState<InlineComposerPosition | null>(null);

  callbackRef.current = {
    onContentChange,
    onSelectionChange,
  };

  const updateComposerPosition = useCallback((view: EditorView, nextSelection: CanvasSelection | null) => {
    const surface = surfaceRef.current;
    if (!surface || !nextSelection) {
      setInlineComposerPosition(null);
      return;
    }

    const anchor = view.coordsAtPos(nextSelection.end) ?? view.coordsAtPos(nextSelection.start);
    if (!anchor) {
      setInlineComposerPosition(null);
      return;
    }

    const surfaceRect = surface.getBoundingClientRect();
    const rawLeft = anchor.left - surfaceRect.left;
    const maxLeft = Math.max(12, surface.clientWidth - INLINE_COMPOSER_MAX_WIDTH - 12);
    const left = clamp(rawLeft, 12, maxLeft);

    const belowTop = anchor.bottom - surfaceRect.top + 10;
    const aboveTop = anchor.top - surfaceRect.top - INLINE_COMPOSER_HEIGHT - 10;
    const maxTop = Math.max(12, surface.clientHeight - INLINE_COMPOSER_HEIGHT - 12);
    const top = belowTop <= maxTop ? belowTop : clamp(aboveTop, 12, maxTop);

    setInlineComposerPosition({ left, top });
  }, []);

  const extensions = useMemo(() => {
    const contentAttributes = EditorView.contentAttributes.of({
      spellcheck: canvas.kind !== 'code' ? 'true' : 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
      translate: 'no',
    });

    const updateListener = EditorView.updateListener.of((update) => {
      const nextSelection = getCanvasSelection(update.state);

      if (update.docChanged && !suppressEditorEventsRef.current) {
        callbackRef.current.onContentChange(update.state.doc.toString());
      }

      if ((update.selectionSet || update.docChanged) && !suppressEditorEventsRef.current && !areSelectionsEqual(lastSelectionRef.current, nextSelection)) {
        lastSelectionRef.current = nextSelection;
        callbackRef.current.onSelectionChange(nextSelection);
      }

      if (update.selectionSet || update.docChanged || update.viewportChanged) {
        updateComposerPosition(update.view, nextSelection);
      }
    });

    return [
      minimalSetup,
      drawSelection(),
      canvasEditorTheme,
      contentAttributes,
      markdown(),
      canvas.kind === 'code' ? [] : EditorView.lineWrapping,
      updateListener,
    ];
  }, [canvas.kind, updateComposerPosition]);

  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) {
      return undefined;
    }

    host.replaceChildren();
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        selection: selection ? EditorSelection.range(selection.start, selection.end) : undefined,
        extensions,
      }),
      parent: host,
    });

    editorViewRef.current = view;
    lastSelectionRef.current = selection;
    updateComposerPosition(view, selection);

    const handleViewportChange = () => updateComposerPosition(view, getCanvasSelection(view.state));
    view.scrollDOM.addEventListener('scroll', handleViewportChange);
    window.addEventListener('resize', handleViewportChange);

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleViewportChange);
      window.removeEventListener('resize', handleViewportChange);
      view.destroy();
      editorViewRef.current = null;
    };
  }, [extensions, updateComposerPosition]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    const currentDoc = view.state.doc.toString();
    if (currentDoc === content) {
      return;
    }

    const { main } = view.state.selection;
    const nextCursor = Math.min(main.head, content.length);

    suppressEditorEventsRef.current = true;
    view.dispatch({
      changes: { from: 0, to: currentDoc.length, insert: content },
      selection: EditorSelection.cursor(nextCursor),
    });
    suppressEditorEventsRef.current = false;

    updateComposerPosition(view, getCanvasSelection(view.state));
  }, [content, updateComposerPosition]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    const { main } = view.state.selection;
    const currentSelection = main.empty
      ? null
      : {
          start: Math.min(main.from, main.to),
          end: Math.max(main.from, main.to),
          text: view.state.doc.sliceString(Math.min(main.from, main.to), Math.max(main.from, main.to)),
        };

    if (areSelectionsEqual(currentSelection, selection)) {
      updateComposerPosition(view, selection);
      return;
    }

    suppressEditorEventsRef.current = true;
    view.dispatch({
      selection: selection ? EditorSelection.range(selection.start, selection.end) : EditorSelection.cursor(main.head),
      scrollIntoView: Boolean(selection),
    });
    suppressEditorEventsRef.current = false;

    lastSelectionRef.current = selection;
    updateComposerPosition(view, selection);
  }, [selection, updateComposerPosition]);

  useEffect(() => {
    if (!selection || !inlineComposerPosition) {
      return;
    }

    requestAnimationFrame(() => {
      selectionPromptRef.current?.focus();
    });
  }, [inlineComposerPosition, selection]);

  useEffect(() => {
    if (!selection) {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (surfaceRef.current?.contains(target) || selectionComposerRef.current?.contains(target)) {
        return;
      }

      onClearSelection();
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [onClearSelection, selection]);

  const inlineComposerStyle: CSSProperties | undefined = inlineComposerPosition
    ? {
        left: `${inlineComposerPosition.left}px`,
        top: `${inlineComposerPosition.top}px`,
      }
    : undefined;
  const editorShellClassName = `canvas-editor-shell${canvas.kind === 'code' ? ' canvas-editor-shell--code' : ''}`;

  return (
    <div ref={surfaceRef} className="canvas-editor-surface">
      <div ref={editorHostRef} className={editorShellClassName} aria-label={`Editing ${canvas.title}`} />

      {selection && inlineComposerStyle ? (
        <div
          ref={selectionComposerRef}
          className="canvas-selection-inline"
          style={inlineComposerStyle}
        >
          <input
            ref={selectionPromptRef}
            className="canvas-selection-inline-input"
            value={selectionPromptDraft}
            onChange={(event) => onSelectionPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSubmitSelectionPrompt();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onClearSelection();
                requestAnimationFrame(() => editorViewRef.current?.focus());
              }
            }}
            placeholder="Edit selected text…"
            aria-label={`Edit selected text in ${canvas.title}`}
          />
          <button
            type="button"
            className="canvas-selection-inline-send"
            onClick={onSubmitSelectionPrompt}
            disabled={selectionSubmitDisabled || !selectionPromptDraft.trim()}
            aria-label="Apply selection edit"
            title="Apply selection edit"
          >
            <SendSelectionIcon />
          </button>
        </div>
      ) : null}
    </div>
  );
}
