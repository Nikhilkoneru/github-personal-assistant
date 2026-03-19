import type { CanvasArtifact, ChatMessage, ChatToolActivity } from '../lib/types.js';
import { MarkdownContent } from './markdown-content.js';

type MessageBubbleProps = {
  message: ChatMessage;
  isStreaming?: boolean;
  canvasReferences?: CanvasArtifact[];
  onOpenCanvas?: (canvasId: string) => void;
};

const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const toolStatusLabels = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
} satisfies Record<ChatToolActivity['status'], string>;

/** Strip the canvas system-prompt wrapper so the user only sees their original request. */
const stripCanvasWrapper = (text: string): string => {
  // Pattern: wrapper starts with "The user wants to create/edit/revise…" and ends with "User request:\n<original>"
  const marker = '\nUser request:\n';
  const idx = text.lastIndexOf(marker);
  if (idx !== -1) return text.slice(idx + marker.length).trim();
  return text;
};

const formatToolPayload = (value?: string) => {
  if (!value) return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
};

const summarizeToolActivity = (activity: ChatToolActivity) => {
  if (activity.error) return activity.error;
  if (activity.additionalContext) return activity.additionalContext;
  if (activity.result) return activity.result.trim().split('\n')[0];
  if (activity.arguments) return formatToolPayload(activity.arguments)?.split('\n')[0];
  return toolStatusLabels[activity.status];
};

export function MessageBubble({ message, isStreaming, canvasReferences, onOpenCanvas }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isError = message.role === 'error';
  const isAssistant = message.role === 'assistant';
  const isPending = isAssistant && !message.content && !message.metadata?.reasoning;

  const reasoningState = message.metadata?.reasoningState as 'streaming' | 'complete' | undefined;
  const isThinking = reasoningState === 'streaming';
  const hasReasoning = Boolean(message.metadata?.reasoning);
  const toolActivities = [...(message.metadata?.toolActivities ?? [])].sort(
    (left, right) => new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime(),
  );

  return (
    <div className={`msg${isUser ? ' msg--user' : ''}${isError ? ' msg--error' : ''}`}>
      {!isUser ? (
        <div className="msg-avatar">
          <svg className="msg-avatar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2a7 7 0 0 0-4.5 12.35V22l4.5-2.5 4.5 2.5v-7.65A7 7 0 0 0 12 2z" />
          </svg>
        </div>
      ) : null}
      <div className="msg-body">
        {(isThinking || (isPending && isStreaming)) ? (
          <div className="thinking-live">
            <div className="thinking-pulse" />
            <div>
              <span className="thinking-label">{isThinking ? 'Thinking…' : 'Working…'}</span>
              {isThinking && message.metadata?.reasoning ? (
                <MarkdownContent content={message.metadata.reasoning} className="thinking-preview" />
              ) : null}
            </div>
          </div>
        ) : null}

        {hasReasoning && !isThinking ? (
          <details className="reasoning-block">
            <summary className="reasoning-toggle">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm6.5-.25A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 110-2 1 1 0 010 2z" />
              </svg>
              Reasoning
            </summary>
            <MarkdownContent content={message.metadata!.reasoning as string} className="reasoning-text" />
          </details>
        ) : null}

        {message.metadata?.phase ? <div className="msg-phase">{message.metadata.phase}</div> : null}

        {message.metadata?.planItems?.length ? (
          <div className="msg-plan">
            <div className="msg-plan-label">Plan</div>
            <ul className="msg-plan-list">
              {message.metadata.planItems.map((item, index) => (
                <li key={`${message.id}-plan-${index}`}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {message.content ? (
          isUser ? <div className="msg-content">{stripCanvasWrapper(message.content)}</div> : <MarkdownContent content={message.content} className="msg-content markdown-content" />
        ) : null}

        {toolActivities.length ? (() => {
          const running = toolActivities.filter((a) => a.status === 'running');
          const completed = toolActivities.filter((a) => a.status === 'completed');
          const failed = toolActivities.filter((a) => a.status === 'failed');

          return (
            <div className="tool-activity-list">
              {/* Running tools: show expanded */}
              {running.map((activity) => (
                <section key={activity.id} className="tool-activity tool-activity--running">
                  <div className="tool-activity-header">
                    <div className="tool-activity-title-row">
                      <span className="tool-activity-indicator tool-activity-indicator--running" aria-hidden="true" />
                      <span className="tool-activity-name">{activity.toolName}</span>
                      <span className="tool-activity-badge tool-activity-badge--running">Running</span>
                    </div>
                    <time className="tool-activity-time">{formatTime(activity.updatedAt)}</time>
                  </div>
                  <div className="tool-activity-summary">{summarizeToolActivity(activity)}</div>
                </section>
              ))}

              {/* Completed tools: compact stacked group */}
              {completed.length ? (
                <details className="tool-activity-group tool-activity-group--completed">
                  <summary className="tool-activity-group-summary">
                    <span className="tool-activity-indicator tool-activity-indicator--completed" aria-hidden="true" />
                    <span className="tool-activity-group-label">
                      {completed.length} tool{completed.length > 1 ? 's' : ''} completed
                    </span>
                    <span className="tool-activity-group-names">
                      {completed.map((a) => a.toolName).join(', ')}
                    </span>
                    <span className="tool-activity-group-chevron" aria-hidden="true">▸</span>
                  </summary>
                  <div className="tool-activity-group-body">
                    {completed.map((activity) => (
                      <details key={activity.id} className="tool-activity tool-activity--completed">
                        <summary className="tool-activity-collapse-summary">
                          <div className="tool-activity-header">
                            <div className="tool-activity-title-row">
                              <span className="tool-activity-indicator tool-activity-indicator--completed" aria-hidden="true" />
                              <span className="tool-activity-name">{activity.toolName}</span>
                            </div>
                            <time className="tool-activity-time">{formatTime(activity.updatedAt)}</time>
                          </div>
                        </summary>
                        <div className="tool-activity-summary">{summarizeToolActivity(activity)}</div>
                        {activity.arguments ? (
                          <div className="tool-activity-section">
                            <div className="tool-activity-label">Arguments</div>
                            <pre className="tool-activity-payload">{formatToolPayload(activity.arguments)}</pre>
                          </div>
                        ) : null}
                        {activity.result ? (
                          <div className="tool-activity-section">
                            <div className="tool-activity-label">Result</div>
                            <pre className="tool-activity-payload">{formatToolPayload(activity.result)}</pre>
                          </div>
                        ) : null}
                      </details>
                    ))}
                  </div>
                </details>
              ) : null}

              {/* Failed tools: show individually */}
              {failed.map((activity) => (
                <section key={activity.id} className="tool-activity tool-activity--failed">
                  <div className="tool-activity-header">
                    <div className="tool-activity-title-row">
                      <span className="tool-activity-indicator tool-activity-indicator--failed" aria-hidden="true" />
                      <span className="tool-activity-name">{activity.toolName}</span>
                      <span className="tool-activity-badge tool-activity-badge--failed">Failed</span>
                    </div>
                    <time className="tool-activity-time">{formatTime(activity.updatedAt)}</time>
                  </div>
                  <div className="tool-activity-text tool-activity-text--error">{activity.error}</div>
                </section>
              ))}
            </div>
          );
        })() : null}

        {message.attachments?.length ? (
          <div className="msg-attachments">
            {message.attachments.map((attachment) => (
              <span key={attachment.id} className="msg-attachment">{attachment.name}</span>
            ))}
          </div>
        ) : null}

        {canvasReferences?.length ? (
          <div className="msg-attachments">
            {canvasReferences.map((canvas) => (
              <button
                key={canvas.id}
                type="button"
                className="msg-canvas-link"
                onClick={() => onOpenCanvas?.(canvas.id)}
              >
                Open canvas: {canvas.title}
              </button>
            ))}
          </div>
        ) : null}

        <div className="msg-footer">
          <time className="msg-time">{formatTime(message.createdAt)}</time>
        </div>
      </div>
    </div>
  );
}
