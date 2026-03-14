import type { ChatMessage } from '@github-personal-assistant/shared';

type MessageBubbleProps = {
  message: ChatMessage;
};

const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const formatCount = (value?: number) => (typeof value === 'number' ? value.toLocaleString() : null);

export function MessageBubble({ message }: MessageBubbleProps) {
  const roleClass = message.role === 'user' ? 'user' : message.role === 'error' ? 'error' : 'assistant';
  const isPendingAssistant = message.role === 'assistant' && !message.content;
  const bodyText = isPendingAssistant ? 'Thinking…' : message.content;
  const usageBits = [
    formatCount(message.metadata?.usage?.inputTokens) ? `${formatCount(message.metadata?.usage?.inputTokens)} in` : null,
    formatCount(message.metadata?.usage?.outputTokens) ? `${formatCount(message.metadata?.usage?.outputTokens)} out` : null,
    typeof message.metadata?.usage?.duration === 'number' ? `${Math.round(message.metadata.usage.duration)} ms` : null,
  ].filter((bit): bit is string => Boolean(bit));

  return (
    <div className={`message-row ${roleClass}`}>
      <article className="message-bubble">
        <div className="message-body">{bodyText}</div>
        {message.metadata?.reasoning ? (
          <details className="message-detail">
            <summary>Thinking</summary>
            <div className="message-detail-body">{message.metadata.reasoning}</div>
          </details>
        ) : null}
        {message.metadata?.toolActivities?.length ? (
          <details className="message-detail">
            <summary>Tool activity</summary>
            <div className="tool-activity-list">
              {message.metadata.toolActivities.map((activity) => (
                <div key={activity.id} className="tool-activity-item">
                  <div className="tool-activity-title">
                    {activity.toolName} · {activity.status}
                  </div>
                  {activity.additionalContext ? <div className="tool-activity-copy">{activity.additionalContext}</div> : null}
                  {activity.result ? <div className="tool-activity-copy">{activity.result}</div> : null}
                  {activity.error ? <div className="tool-activity-copy error">{activity.error}</div> : null}
                </div>
              ))}
            </div>
          </details>
        ) : null}
        {usageBits.length ? <div className="message-usage">{usageBits.join(' · ')}</div> : null}
        {message.attachments?.length ? (
          <div className="attachment-chip-row">
            {message.attachments.map((attachment) => (
              <span key={attachment.id} className="attachment-chip">
                {attachment.kind === 'image'
                  ? 'Image'
                  : attachment.kind === 'audio'
                    ? 'Audio'
                    : attachment.kind === 'video'
                      ? 'Video'
                      : attachment.kind === 'document'
                        ? 'Document'
                        : 'File'}
                {`: ${attachment.name}`}
              </span>
            ))}
          </div>
        ) : null}
        <div className="message-meta">{message.role === 'error' ? 'Error' : roleClass} · {formatTime(message.createdAt)}</div>
      </article>
    </div>
  );
}
