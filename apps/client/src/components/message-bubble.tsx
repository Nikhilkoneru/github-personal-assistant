import { StyleSheet, Text, View } from 'react-native';

import type { ChatMessage } from '@github-personal-assistant/shared';

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const isError = message.role === 'error';
  const isPendingAssistant = message.role === 'assistant' && !message.content;
  const bodyText = isPendingAssistant ? 'Thinking…' : message.content;

  return (
    <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : isError ? styles.errorBubble : styles.assistantBubble]}>
        {isError ? <Text style={styles.errorLabel}>Error</Text> : null}
        <Text style={[styles.body, isPendingAssistant && styles.pendingBody]}>{bodyText}</Text>
        {message.attachments?.length ? (
          <View style={styles.attachmentList}>
            {message.attachments.map((attachment) => (
              <View key={attachment.id} style={styles.attachmentChip}>
                <Text style={styles.attachmentChipText}>
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
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    width: '100%',
  },
  rowLeft: {
    alignItems: 'flex-start',
  },
  rowRight: {
    alignItems: 'flex-end',
  },
  bubble: {
    maxWidth: '88%',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
    borderWidth: 1,
  },
  assistantBubble: {
    backgroundColor: '#0f172a',
    borderColor: '#1e293b',
  },
  userBubble: {
    backgroundColor: '#1d4ed8',
    borderColor: '#3b82f6',
  },
  errorBubble: {
    backgroundColor: '#3b1515',
    borderColor: '#7f1d1d',
  },
  errorLabel: {
    color: '#fecaca',
    fontSize: 12,
    fontWeight: '700',
  },
  body: {
    color: '#f8fafc',
    fontSize: 15,
    lineHeight: 22,
  },
  pendingBody: {
    color: '#93c5fd',
    fontStyle: 'italic',
  },
  attachmentList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  attachmentChip: {
    borderRadius: 999,
    backgroundColor: 'rgba(15, 23, 42, 0.52)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.28)',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  attachmentChipText: {
    color: '#dbeafe',
    fontSize: 12,
    fontWeight: '600',
  },
});
