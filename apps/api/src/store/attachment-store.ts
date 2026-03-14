import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AttachmentKind, AttachmentSummary } from '@github-personal-assistant/shared';

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
  name: string;
  mime_type: string;
  size: number;
  kind: AttachmentKind;
  file_path: string;
  pdf_context_file_path: string | null;
  pdf_extraction: PdfDocumentContext['extraction'] | null;
  pdf_page_count: number | null;
  pdf_title: string | null;
  uploaded_at: string;
};

export type ThreadAttachmentReference = AttachmentSummary & {
  filePath: string;
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
  originalName,
  mimeType,
  bytes,
}: {
  ownerId: string;
  threadId?: string;
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
        id, github_user_id, thread_id, name, mime_type, size, kind, file_path, pdf_context_file_path, pdf_extraction, pdf_page_count, pdf_title,
        created_at, updated_at, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attachmentId,
      ownerId,
      threadId ?? null,
      originalName,
      mimeType,
      bytes.byteLength,
      getAttachmentKind(mimeType),
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

export const listThreadAttachmentReferences = (ownerId: string, threadId: string): ThreadAttachmentReference[] =>
  (
    db
      .prepare('SELECT * FROM attachments WHERE github_user_id = ? AND thread_id = ? ORDER BY uploaded_at ASC')
      .all(ownerId, threadId) as AttachmentRow[]
  ).map((row) => ({
    ...toSummary(row),
    filePath: row.file_path,
  }));

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
