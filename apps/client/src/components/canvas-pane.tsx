import type { CanvasArtifact, CanvasSelection } from '../lib/types.js';
import { CanvasEditor } from './canvas-editor.js';

type CanvasPaneProps = {
  canvases: CanvasArtifact[];
  activeCanvasId: string | null;
  canvas: CanvasArtifact | null;
  selection: CanvasSelection | null;
  selectionPromptDraft: string;
  saving?: boolean;
  onClose: () => void;
  onCreateCanvas?: () => void;
  onSelectCanvas: (canvasId: string) => void;
  onTitleChange: (canvasId: string, title: string) => void;
  onContentChange: (canvasId: string, content: string) => void;
  onSelectionChange: (canvasId: string, selection: CanvasSelection | null) => void;
  onSelectionPromptChange: (value: string) => void;
  onSubmitSelectionPrompt: () => void;
  onClearSelection: () => void;
  onCopy: (canvas: CanvasArtifact) => void;
  selectionSubmitDisabled?: boolean;
};

export function CanvasPane({
  canvases,
  activeCanvasId,
  canvas,
  selection,
  selectionPromptDraft,
  saving,
  onClose,
  onCreateCanvas,
  onSelectCanvas,
  onTitleChange: _onTitleChange,
  onContentChange,
  onSelectionChange,
  onSelectionPromptChange,
  onSubmitSelectionPrompt,
  onClearSelection,
  onCopy,
  selectionSubmitDisabled,
}: CanvasPaneProps) {
  return (
    <aside className="canvas-pane">
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
              {onCreateCanvas ? (
                <button type="button" className="canvas-header-btn" onClick={onCreateCanvas} aria-label="Create canvas" title="New canvas">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8.75 1.75a.75.75 0 0 0-1.5 0v5.5h-5.5a.75.75 0 0 0 0 1.5h5.5v5.5a.75.75 0 0 0 1.5 0v-5.5h5.5a.75.75 0 0 0 0-1.5h-5.5v-5.5z"/></svg>
                </button>
              ) : null}
              <button type="button" className="canvas-header-btn" onClick={() => onCopy(canvas)} aria-label="Copy" title="Copy content">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>
              </button>
            </>
          ) : null}
        </div>
      </div>

      {canvases.length ? (
        <div className="canvas-strip" role="tablist" aria-label="Thread canvases">
          {canvases.map((item) => {
            const isActive = item.id === activeCanvasId;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`canvas-strip-item${isActive ? ' canvas-strip-item--active' : ''}`}
                onClick={() => onSelectCanvas(item.id)}
              >
                <span className="canvas-strip-item-title">{item.title}</span>
                <span className="canvas-strip-item-meta">{item.kind}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {canvas ? (
        <div className="canvas-document">
          <CanvasEditor
            key={`${canvas.id}:${canvas.kind}`}
            canvas={canvas}
            content={canvas.content}
            selection={selection}
            selectionPromptDraft={selectionPromptDraft}
            onContentChange={(content) => onContentChange(canvas.id, content)}
            onSelectionChange={(nextSelection) => onSelectionChange(canvas.id, nextSelection)}
            onSelectionPromptChange={onSelectionPromptChange}
            onSubmitSelectionPrompt={onSubmitSelectionPrompt}
            onClearSelection={onClearSelection}
            selectionSubmitDisabled={selectionSubmitDisabled}
          />
        </div>
      ) : (
        <div className="canvas-empty canvas-empty--editor">
          Ask the assistant to create or update a canvas, then edit it here like a document.
        </div>
      )}
    </aside>
  );
}
