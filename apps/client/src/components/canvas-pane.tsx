import { useMemo } from 'react';

import type { CanvasArtifact, CanvasSelection } from '../lib/types.js';

type CanvasPaneProps = {
  canvases: CanvasArtifact[];
  activeCanvasId: string | null;
  selection: CanvasSelection | null;
  saving?: boolean;
  onSelectCanvas: (canvasId: string) => void;
  onClose: () => void;
  onCreateCanvas: () => void;
  onTitleChange: (canvasId: string, title: string) => void;
  onContentChange: (canvasId: string, content: string) => void;
  onContentBlur: (canvasId: string, title: string, content: string) => void;
  onSelectionChange: (canvasId: string, selection: CanvasSelection | null) => void;
  onCopy: (canvas: CanvasArtifact) => void;
};

export function CanvasPane({
  canvases,
  activeCanvasId,
  selection,
  saving,
  onSelectCanvas,
  onClose,
  onCreateCanvas,
  onTitleChange,
  onContentChange,
  onContentBlur,
  onSelectionChange,
  onCopy,
}: CanvasPaneProps) {
  const activeCanvas = useMemo(
    () => canvases.find((canvas) => canvas.id === activeCanvasId) ?? canvases[0] ?? null,
    [activeCanvasId, canvases],
  );

  return (
    <aside className="canvas-pane">
      <div className="canvas-pane-sidebar">
        <div className="canvas-pane-sidebar-head">
          <div>
            <div className="status-label">Canvas</div>
            <div className="helper-text">{canvases.length ? `${canvases.length} saved` : 'No canvases yet'}</div>
          </div>
          <button type="button" className="ghost-button" onClick={onCreateCanvas}>New</button>
        </div>
        <div className="canvas-list">
          {canvases.length ? (
            canvases.map((canvas) => (
              <button
                key={canvas.id}
                type="button"
                className={`canvas-list-item${canvas.id === activeCanvas?.id ? ' active' : ''}`}
                onClick={() => onSelectCanvas(canvas.id)}
              >
                <span className="canvas-list-title">{canvas.title}</span>
                <span className="canvas-list-meta">{canvas.kind} · r{canvas.latestRevisionNumber}</span>
              </button>
            ))
          ) : (
            <div className="canvas-empty">Use “New” or ask Copilot to use canvas.</div>
          )}
        </div>
      </div>

      <div className="canvas-editor-shell">
        <div className="canvas-editor-header">
          <div className="canvas-editor-header-copy">
            <div className="status-label">Open canvas</div>
            <div className="helper-text">
              {activeCanvas ? `${activeCanvas.kind} · revision ${activeCanvas.latestRevisionNumber}` : 'Select a canvas'}
            </div>
          </div>
          <div className="canvas-editor-actions">
            {activeCanvas ? (
              <button type="button" className="ghost-button" onClick={() => onCopy(activeCanvas)}>
                Copy
              </button>
            ) : null}
            <button type="button" className="ghost-button" onClick={onClose}>Close</button>
          </div>
        </div>

        {activeCanvas ? (
          <>
            <input
              className="input canvas-title-input"
              value={activeCanvas.title}
              onChange={(event) => onTitleChange(activeCanvas.id, event.target.value)}
              onBlur={(event) => onContentBlur(activeCanvas.id, event.target.value, activeCanvas.content)}
              aria-label="Canvas title"
              placeholder="Canvas title"
            />
            <textarea
              className="canvas-editor"
              value={activeCanvas.content}
              onChange={(event) => onContentChange(activeCanvas.id, event.target.value)}
              onBlur={(event) => onContentBlur(activeCanvas.id, activeCanvas.title, event.target.value)}
              onSelect={(event) => {
                const target = event.currentTarget;
                const start = target.selectionStart ?? 0;
                const end = target.selectionEnd ?? 0;
                if (end <= start) {
                  onSelectionChange(activeCanvas.id, null);
                  return;
                }
                onSelectionChange(activeCanvas.id, {
                  start,
                  end,
                  text: target.value.slice(start, end),
                });
              }}
              spellCheck={activeCanvas.kind !== 'code'}
              aria-label={`Canvas editor for ${activeCanvas.title}`}
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
            Create a canvas or open one from chat to start drafting here.
          </div>
        )}
      </div>
    </aside>
  );
}
