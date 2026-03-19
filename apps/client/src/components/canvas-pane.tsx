import { useState, useRef, useCallback } from 'react';
import type { CanvasArtifact, CanvasSelection } from '../lib/types.js';
import { MarkdownContent } from './markdown-content.js';

type CanvasPaneProps = {
  canvas: CanvasArtifact | null;
  selection: CanvasSelection | null;
  saving?: boolean;
  onClose: () => void;
  onTitleChange: (canvasId: string, title: string) => void;
  onContentChange: (canvasId: string, content: string) => void;
  onContentBlur: (canvasId: string, title: string, content: string) => void;
  onSelectionChange: (canvasId: string, selection: CanvasSelection | null) => void;
  onCopy: (canvas: CanvasArtifact) => void;
};

export function CanvasPane({
  canvas,
  selection,
  saving,
  onClose,
  onTitleChange,
  onContentChange,
  onContentBlur,
  onSelectionChange,
  onCopy,
}: CanvasPaneProps) {
  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const enterEditMode = useCallback(() => {
    setEditing(true);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, []);

  const exitEditMode = useCallback(() => {
    if (canvas) {
      onContentBlur(canvas.id, canvas.title, canvas.content);
    }
    setEditing(false);
  }, [canvas, onContentBlur]);

  return (
    <aside className="canvas-pane">
      {/* Header: close X | centered title | action icons */}
      <div className="canvas-header">
        <button type="button" className="canvas-header-btn" onClick={onClose} aria-label="Close canvas" title="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>
        </button>

        <div className="canvas-header-center">
          {canvas ? (
            <span className="canvas-header-title">{canvas.title}</span>
          ) : null}
          {saving ? <span className="canvas-saving-dot" title="Saving…" /> : null}
        </div>

        <div className="canvas-header-actions">
          {canvas ? (
            <>
              <button type="button" className="canvas-header-btn" onClick={() => onCopy(canvas)} aria-label="Copy" title="Copy content">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>
              </button>
            </>
          ) : null}
        </div>
      </div>

      {/* Document body */}
      {canvas ? (
        <div className="canvas-document">
          {editing ? (
            <>
              <textarea
                ref={editorRef}
                className="canvas-editor"
                value={canvas.content}
                onChange={(event) => onContentChange(canvas.id, event.target.value)}
                onBlur={() => exitEditMode()}
                onSelect={(event) => {
                  const target = event.currentTarget;
                  const start = target.selectionStart ?? 0;
                  const end = target.selectionEnd ?? 0;
                  if (end <= start) {
                    onSelectionChange(canvas.id, null);
                    return;
                  }
                  onSelectionChange(canvas.id, { start, end, text: target.value.slice(start, end) });
                }}
                spellCheck={canvas.kind !== 'code'}
                aria-label={`Editing ${canvas.title}`}
              />
              {selection ? (
                <div className="canvas-selection-hint">
                  {selection.end - selection.start} chars selected — type in chat to edit this section
                </div>
              ) : null}
            </>
          ) : (
            <div className="canvas-rendered" onClick={enterEditMode} role="button" tabIndex={0} aria-label="Click to edit">
              <MarkdownContent content={canvas.content} className="canvas-markdown" />
            </div>
          )}

          {/* Floating edit FAB */}
          {!editing ? (
            <button type="button" className="canvas-fab" onClick={enterEditMode} aria-label="Edit document" title="Edit">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.098a.25.25 0 00-.064.108l-.563 1.97 1.971-.564a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354L12.427 2.487z"/></svg>
            </button>
          ) : null}
        </div>
      ) : (
        <div className="canvas-empty canvas-empty--editor">
          Ask the AI to use canvas, or it will open one automatically when drafting.
        </div>
      )}
    </aside>
  );
}
