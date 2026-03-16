import type { ChatMessage, ChatToolActivity } from '../lib/types.js';
import { MarkdownContent } from './markdown-content.js';

type MessageBubbleProps = {
  message: ChatMessage;
  isStreaming?: boolean;
};

const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const toolStatusLabels = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
} satisfies Record<ChatToolActivity['status'], string>;

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

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
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
  const usage = message.metadata?.usage;

  const usageParts: string[] = [];
  if (usage?.inputTokens) usageParts.push(`${usage.inputTokens.toLocaleString()} in`);
  if (usage?.outputTokens) usageParts.push(`${usage.outputTokens.toLocaleString()} out`);
  if (typeof usage?.duration === 'number') usageParts.push(`${(usage.duration / 1000).toFixed(1)}s`);

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
                <div className="thinking-preview">{message.metadata.reasoning}</div>
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
            <div className="reasoning-text">{message.metadata!.reasoning}</div>
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
          isUser ? <div className="msg-content">{message.content}</div> : <MarkdownContent content={message.content} className="msg-content markdown-content" />
        ) : null}

        {toolActivities.length ? (
          <div className="tool-activity-list">
            {toolActivities.map((activity) => {
              const isRunning = activity.status === 'running';
              const header = (
                <div className="tool-activity-header">
                  <div className="tool-activity-title-row">
                    <span className={`tool-activity-indicator tool-activity-indicator--${activity.status}`} aria-hidden="true" />
                    <span className="tool-activity-name">{activity.toolName}</span>
                    <span className={`tool-activity-badge tool-activity-badge--${activity.status}`}>{toolStatusLabels[activity.status]}</span>
                  </div>
                  <time className="tool-activity-time">{formatTime(activity.updatedAt)}</time>
                </div>
              );

              const body = (
                <>
                  <div className="tool-activity-summary">{summarizeToolActivity(activity)}</div>

                  {activity.permissionDecision || activity.permissionDecisionReason || activity.suppressed ? (
                    <div className="tool-activity-note">
                      {activity.permissionDecision ? `Permission: ${activity.permissionDecision}` : 'Permission update'}
                      {activity.permissionDecisionReason ? ` - ${activity.permissionDecisionReason}` : ''}
                      {activity.suppressed ? ' - hidden from assistant output' : ''}
                    </div>
                  ) : null}

                  {activity.arguments ? (
                    <div className="tool-activity-section">
                      <div className="tool-activity-label">Arguments</div>
                      <pre className="tool-activity-payload">{formatToolPayload(activity.arguments)}</pre>
                    </div>
                  ) : null}

                  {activity.additionalContext ? (
                    <div className="tool-activity-section">
                      <div className="tool-activity-label">Progress</div>
                      <div className="tool-activity-text">{activity.additionalContext}</div>
                    </div>
                  ) : null}

                  {activity.result ? (
                    <div className="tool-activity-section">
                      <div className="tool-activity-label">Result</div>
                      <pre className="tool-activity-payload">{formatToolPayload(activity.result)}</pre>
                    </div>
                  ) : null}

                  {activity.error ? (
                    <div className="tool-activity-section">
                      <div className="tool-activity-label">Error</div>
                      <div className="tool-activity-text tool-activity-text--error">{activity.error}</div>
                    </div>
                  ) : null}
                </>
              );

              // Running tools stay expanded; completed/failed collapse into a <details>
              if (isRunning) {
                return (
                  <section key={activity.id} className={`tool-activity tool-activity--running`}>
                    {header}
                    {body}
                  </section>
                );
              }

              return (
                <details key={activity.id} className={`tool-activity tool-activity--${activity.status}`}>
                  <summary className="tool-activity-collapse-summary">
                    {header}
                  </summary>
                  {body}
                </details>
              );
            })}
          </div>
        ) : null}

        {message.attachments?.length ? (
          <div className="msg-attachments">
            {message.attachments.map((attachment) => (
              <span key={attachment.id} className="msg-attachment">{attachment.name}</span>
            ))}
          </div>
        ) : null}

        <div className="msg-footer">
          <time className="msg-time">{formatTime(message.createdAt)}</time>
          {usageParts.length ? <span className="msg-usage">{usageParts.join(' · ')}</span> : null}
        </div>
      </div>
    </div>
  );
}
