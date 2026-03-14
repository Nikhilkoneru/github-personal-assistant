import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AttachmentKind, AttachmentSummary, AttachmentScope } from '@github-personal-assistant/shared';

import { env } from '../config';
import { db, nowIso } from '../db';
import {
  extractPdfDocumentContext,
  formatPdfContextForPrompt,
  type PdfDocumentContext,
} from '../services/pdf';

type AttachmentRow = {
  id: string;
  github_user_id: string;
  thread_id: string | null;
  project_id: string | null;
  name: string;
  mime_type: string;
  size: number;
  kind: AttachmentKind;
  scope: AttachmentScope;
  knowledge_status: AttachmentSummary['knowledgeStatus'];
  file_path: string;
  pdf_context_file_path: string | null;
  pdf_extraction: PdfDocumentContext['extraction'] | null;
  pdf_page_count: number | null;
  pdf_title: string | null;
  ragflow_dataset_id: string | null;
  ragflow_document_id: string | null;
  uploaded_at: string;
};

const sanitizeName = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'attachment';

const ownerDirectory = (ownerId: string) => path.join(env.mediaRoot, ownerId);
const pdfContextPath = (ownerId: string, attachmentId: string) => path.join(ownerDirectory(ownerId), `${attachmentId}.pdf-context.json`);

const getAttachmentKind = (mimeType: string): AttachmentKind => {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  if (mimeType === 'application/pdf' || mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml')) {
    return 'document';
  }
  return 'other';
};

const toSummary = (attachment: AttachmentRow): AttachmentSummary => ({
  id: attachment.id,
  name: attachment.name,
  mimeType: attachment.mime_type,
  size: attachment.size,
  kind: attachment.kind,
  uploadedAt: attachment.uploaded_at,
  scope: attachment.scope,
  knowledgeStatus: attachment.knowledge_status,
});

const getAttachmentRows = (ownerId: string, attachmentIds: string[]) => {
  if (attachmentIds.length === 0) {
    return [] as AttachmentRow[];
  }

  return db
    .prepare(
      `SELECT * FROM attachments WHERE github_user_id = ? AND id IN (${attachmentIds.map(() => '?').join(',')}) ORDER BY uploaded_at ASC`,
    )
    .all(ownerId, ...attachmentIds) as AttachmentRow[];
};

const loadPdfContext = async (attachment: AttachmentRow) => {
  if (attachment.mime_type !== 'application/pdf') {
    return null;
  }

  const contextFilePath = attachment.pdf_context_file_path ?? pdfContextPath(attachment.github_user_id, attachment.id);
  try {
    const raw = await fsp.readFile(contextFilePath, 'utf8');
    return JSON.parse(raw) as PdfDocumentContext;
  } catch {
    const context = await extractPdfDocumentContext({ filePath: attachment.file_path });
    await fsp.writeFile(contextFilePath, JSON.stringify(context, null, 2), 'utf8');
    db.prepare(
      `UPDATE attachments
       SET pdf_context_file_path = ?, pdf_extraction = ?, pdf_page_count = ?, pdf_title = ?, updated_at = ?
       WHERE id = ?`,
    ).run(contextFilePath, context.extraction, context.pageCount, context.title ?? null, nowIso(), attachment.id);
    return context;
  }
};

export const saveAttachment = async ({
  ownerId,
  threadId,
  projectId,
  originalName,
  mimeType,
  bytes,
}: {
  ownerId: string;
  threadId?: string;
  projectId?: string;
  originalName: string;
  mimeType: string;
  bytes: Buffer;
}) => {
  const attachmentId = crypto.randomUUID();
  const uploadedAt = nowIso();
  const ownerDir = ownerDirectory(ownerId);
  const storedFileName = `${attachmentId}-${sanitizeName(originalName)}`;
  const filePath = path.join(ownerDir, storedFileName);
  const attachmentPdfContextPath = pdfContextPath(ownerId, attachmentId);

  await fsp.mkdir(ownerDir, { recursive: true });
  await fsp.writeFile(filePath, bytes);

  let pdfContext: PdfDocumentContext | null = null;
  try {
    if (mimeType === 'application/pdf') {
      pdfContext = await extractPdfDocumentContext({ filePath });
      await fsp.writeFile(attachmentPdfContextPath, JSON.stringify(pdfContext, null, 2), 'utf8');
    }

    db.prepare(`
      INSERT INTO attachments (
        id, github_user_id, thread_id, project_id, name, mime_type, size, kind, scope,
        knowledge_status, file_path, pdf_context_file_path, pdf_extraction, pdf_page_count, pdf_title,
        ragflow_dataset_id, ragflow_document_id, created_at, updated_at, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    `).run(
      attachmentId,
      ownerId,
      threadId ?? null,
      projectId ?? null,
      originalName,
      mimeType,
      bytes.byteLength,
      getAttachmentKind(mimeType),
      'thread',
      'none',
      filePath,
      pdfContext ? attachmentPdfContextPath : null,
      pdfContext?.extraction ?? null,
      pdfContext?.pageCount ?? null,
      pdfContext?.title ?? null,
      uploadedAt,
      uploadedAt,
      uploadedAt,
    );

    return getAttachmentSummary(ownerId, attachmentId);
  } catch (error) {
    await Promise.allSettled([
      fsp.rm(filePath, { force: true }),
      fsp.rm(attachmentPdfContextPath, { force: true }),
    ]);
    throw error;
  }
};

export const getAttachmentRecord = (ownerId: string, attachmentId: string) => {
  return (
    (db.prepare('SELECT * FROM attachments WHERE github_user_id = ? AND id = ?').get(ownerId, attachmentId) as AttachmentRow | undefined) ??
    null
  );
};

export const getAttachmentSummary = (ownerId: string, attachmentId: string) => {
  const row = getAttachmentRecord(ownerId, attachmentId);
  return row ? toSummary(row) : null;
};

export const getAttachmentInputs = async (ownerId: string, attachmentIds: string[]) => {
  const attachments = getAttachmentRows(ownerId, attachmentIds);
  if (attachments.length !== attachmentIds.length) {
    return null;
  }

  return attachments.map((attachment) => ({
    type: 'file' as const,
    path: attachment.file_path,
    displayName: attachment.name,
  }));
};

export const buildAttachmentPromptContext = async ({
  ownerId,
  attachmentIds,
  query,
}: {
  ownerId: string;
  attachmentIds: string[];
  query: string;
}) => {
  const attachments = getAttachmentRows(ownerId, attachmentIds);
  if (attachments.length !== attachmentIds.length) {
    return null;
  }

  const pdfContexts = await Promise.all(
    attachments
      .filter((attachment) => attachment.mime_type === 'application/pdf')
      .map(async (attachment) => {
        const context = await loadPdfContext(attachment);
        return context
          ? formatPdfContextForPrompt({
              attachmentName: attachment.name,
              context,
              query,
            })
          : null;
      }),
  );

  const promptSections = pdfContexts.filter((section): section is string => Boolean(section));
  return promptSections.length > 0 ? promptSections.join('\n\n---\n\n') : '';
};

export const promoteAttachmentToKnowledge = (input: {
  ownerId: string;
  attachmentId: string;
  projectId: string;
  datasetId: string;
  documentId: string;
}) => {
  db.prepare(
    `UPDATE attachments
     SET scope = 'knowledge', knowledge_status = 'pending', project_id = ?, ragflow_dataset_id = ?, ragflow_document_id = ?, updated_at = ?
     WHERE github_user_id = ? AND id = ?`,
  ).run(input.projectId, input.datasetId, input.documentId, nowIso(), input.ownerId, input.attachmentId);

  return getAttachmentSummary(input.ownerId, input.attachmentId);
};

export const updateAttachmentKnowledgeStatus = (input: {
  ownerId: string;
  attachmentId: string;
  knowledgeStatus: AttachmentSummary['knowledgeStatus'];
}) => {
  db.prepare('UPDATE attachments SET knowledge_status = ?, updated_at = ? WHERE github_user_id = ? AND id = ?').run(
    input.knowledgeStatus,
    nowIso(),
    input.ownerId,
    input.attachmentId,
  );
  return getAttachmentSummary(input.ownerId, input.attachmentId);
};

export const getKnowledgeAttachmentsForProject = (ownerId: string, projectId: string) =>
  (db
    .prepare(
      `SELECT * FROM attachments
       WHERE github_user_id = ? AND project_id = ? AND scope = 'knowledge'
       ORDER BY uploaded_at DESC`,
    )
    .all(ownerId, projectId) as AttachmentRow[]);

export const getPdfContextForAttachments = (attachmentIds: string[], ownerId: string) => {
  const attachments = getAttachmentRows(ownerId, attachmentIds);
  const contexts: Array<{ attachmentName: string; context: PdfDocumentContext }> = [];
  for (const attachment of attachments) {
    if (!attachment.pdf_context_file_path) {
      continue;
    }

    try {
      const raw = fs.readFileSync(attachment.pdf_context_file_path, 'utf8');
      contexts.push({
        attachmentName: attachment.name,
        context: JSON.parse(raw) as PdfDocumentContext,
      });
    } catch {
      continue;
    }
  }

  return contexts;
};
