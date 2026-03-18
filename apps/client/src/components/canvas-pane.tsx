import type { CanvasArtifact, CanvasSelection } from '../lib/types.js';

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
  return (
    <aside className="canvas-pane">
      <div className="canvas-editor-shell">
        <div className="canvas-editor-header">
          <div className="canvas-editor-header-copy">
            {canvas ? (
              <>
                <div className="status-label">{canvas.title}</div>
                <div className="helper-text">{canvas.kind} · revision {canvas.latestRevisionNumber}</div>
              </>
            ) : (
              <div className="status-label">Canvas</div>
            )}
          </div>
          <div className="canvas-editor-actions">
            {canvas ? (
              <button type="button" className="ghost-button" onClick={() => onCopy(canvas)}>
                Copy
              </button>
            ) : null}
            <button type="button" className="ghost-button" onClick={onClose}>Close</button>
          </div>
        </div>

        {canvas ? (
          <>
            <input
              className="input canvas-title-input"
              value={canvas.title}
              onChange={(event) => onTitleChange(canvas.id, event.target.value)}
              onBlur={(event) => onContentBlur(canvas.id, event.target.value, canvas.content)}
              aria-label="Canvas title"
              placeholder="Canvas title"
            />
            <textarea
              className="canvas-editor"
              value={canvas.content}
              onChange={(event) => onContentChange(canvas.id, event.target.value)}
              onBlur={(event) => onContentBlur(canvas.id, canvas.title, event.target.value)}
              onSelect={(event) => {
                const target = event.currentTarget;
                const start = target.selectionStart ?? 0;
                const end = target.selectionEnd ?? 0;
                if (end <= start) {
                  onSelectionChange(canvas.id, null);
                  return;
                }
                onSelectionChange(canvas.id, {
                  start,
                  end,
                  text: target.value.slice(start, end),
                });
              }}
              spellCheck={canvas.kind !== 'code'}
              aria-label={`Canvas editor for ${canvas.title}`}
            />
            <div className="canvas-footer">
              <div className="helper-text">
                {selection
                  ? `Selected ${selection.end - selection.start} characters for the next canvas-targeted follow-up.`
                  : 'Select text in the canvas to target only that section.'}
              </div>
              {saving ? <div className="helper-text">Saving canvas…</div> : null}
            </div>
          </>
        ) : (
          <div className="canvas-empty canvas-empty--editor">
            Ask the AI to use canvas, or it will open one automatically when drafting.
          </div>
        )}
      </div>
    </aside>
  );
}
