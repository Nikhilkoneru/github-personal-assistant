import type { ChatMessage } from '@github-personal-assistant/shared';

type MessageBubbleProps = {
  message: ChatMessage;
};

const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function MessageBubble({ message }: MessageBubbleProps) {
  const roleClass = message.role === 'user' ? 'user' : message.role === 'error' ? 'error' : 'assistant';
  const isPendingAssistant = message.role === 'assistant' && !message.content;
  const bodyText = isPendingAssistant ? 'Thinking…' : message.content;

  return (
    <div className={`message-row ${roleClass}`}>
      <article className="message-bubble">
        <div className="message-body">{bodyText}</div>
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
                {attachment.scope === 'knowledge' ? ' · project knowledge' : ''}
              </span>
            ))}
          </div>
        ) : null}
        <div className="message-meta">{message.role === 'error' ? 'Error' : roleClass} · {formatTime(message.createdAt)}</div>
      </article>
    </div>
  );
}
