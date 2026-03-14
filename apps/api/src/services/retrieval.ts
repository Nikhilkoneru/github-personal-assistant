import {
  getKnowledgeAttachmentsForProject,
  getPdfContextForAttachments,
  updateAttachmentKnowledgeStatus,
} from '../store/attachment-store';
import { getThread } from '../store/thread-store';
import { formatPdfContextForPrompt, type PdfDocumentContext } from './pdf';
import { listDocumentChunks } from './ragflow';

const MAX_SNIPPETS = 8;
const MAX_CHARS = 12000;
const stopWords = new Set([
  'about', 'after', 'again', 'also', 'been', 'being', 'between', 'could', 'from', 'have', 'into', 'just',
  'more', 'most', 'only', 'should', 'some', 'than', 'that', 'their', 'them', 'there', 'these', 'they',
  'this', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your',
]);

const getQueryTerms = (query: string) =>
  Array.from(new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])).filter((term) => !stopWords.has(term)).slice(0, 14);

const scoreText = (text: string, terms: string[]) => {
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => {
    const matches = haystack.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
    return score + (matches?.length ?? 0);
  }, 0);
};

const excerptText = (value: string, maxChars: number) => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars).trimEnd()}…`;
};

const buildChunkContext = async (projectId: string, query: string, ownerId: string) => {
  const attachments = getKnowledgeAttachmentsForProject(ownerId, projectId);
  if (attachments.length === 0) {
    return '';
  }

  const queryTerms = getQueryTerms(query);
  const scoredChunks: Array<{ documentName: string; score: number; content: string }> = [];

  for (const attachment of attachments) {
    if (!attachment.ragflow_document_id) {
      continue;
    }

    try {
      const chunks = await listDocumentChunks(attachment.ragflow_document_id);
      if (chunks.length > 0 && attachment.knowledge_status !== 'indexed') {
        updateAttachmentKnowledgeStatus({
          ownerId,
          attachmentId: attachment.id,
          knowledgeStatus: 'indexed',
        });
      }

      for (const chunk of chunks) {
        const content = typeof chunk.content === 'string' ? chunk.content : typeof chunk.text === 'string' ? chunk.text : '';
        if (!content.trim()) {
          continue;
        }

        scoredChunks.push({
          documentName: attachment.name,
          score: scoreText(content, queryTerms),
          content,
        });
      }
    } catch {
      continue;
    }
  }

  const selected = scoredChunks
    .sort((left, right) => right.score - left.score || left.documentName.localeCompare(right.documentName))
    .slice(0, MAX_SNIPPETS);

  if (selected.length === 0) {
    return '';
  }

  let totalChars = 0;
  const sections: string[] = [];
  for (const snippet of selected) {
    const content = excerptText(snippet.content.replace(/\s+/g, ' ').trim(), 1500);
    if (!content) {
      continue;
    }

    totalChars += content.length;
    if (totalChars > MAX_CHARS && sections.length > 0) {
      break;
    }

    sections.push(`Document: ${snippet.documentName}\n${content}`);
  }

  return sections.length > 0
    ? ['Project knowledge retrieved from RagFlow chunks. Use this as grounding context and cite document names when relevant.', ...sections].join('\n\n')
    : '';
};

const buildPdfFallbackContext = (pdfContexts: Array<{ attachmentName: string; context: PdfDocumentContext }>, query: string) => {
  const sections = pdfContexts.map(({ attachmentName, context }) =>
    formatPdfContextForPrompt({
      attachmentName,
      context,
      query,
    }),
  );

  return sections.length > 0 ? sections.join('\n\n---\n\n') : '';
};

export const buildKnowledgePromptContext = async ({
  ownerId,
  threadId,
  query,
}: {
  ownerId: string;
  threadId: string;
  query: string;
}) => {
  const thread = getThread(ownerId, threadId);
  if (!thread?.projectId) {
    return '';
  }

  const ragflowContext = await buildChunkContext(thread.projectId, query, ownerId);
  if (ragflowContext) {
    return ragflowContext;
  }

  const pdfContexts = getPdfContextForAttachments(
    getKnowledgeAttachmentsForProject(ownerId, thread.projectId).map((attachment) => attachment.id),
    ownerId,
  );

  return buildPdfFallbackContext(pdfContexts, query);
};
