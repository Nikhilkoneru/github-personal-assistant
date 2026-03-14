import crypto from 'node:crypto';

import type {
  AttachmentSummary,
  ChatMessage,
  ChatRole,
  CreateThreadInput,
  ThreadDetail,
  ThreadSummary,
} from '@github-personal-assistant/shared';

import { env } from '../config';
import { db, nowIso } from '../db';
import { getProjectRecord, touchProject } from './project-store';

type ThreadRow = {
  id: string;
  title: string;
  project_id: string | null;
  project_name: string | null;
  model: string;
  updated_at: string;
  created_at: string;
  copilot_session_id: string | null;
  last_message_preview: string | null;
};

type MessageRow = {
  id: string;
  thread_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
  updated_at: string;
};

const toSummary = (row: ThreadRow): ThreadSummary => ({
  id: row.id,
  title: row.title,
  projectId: row.project_id ?? undefined,
  projectName: row.project_name ?? undefined,
  model: row.model,
  updatedAt: row.updated_at,
  createdAt: row.created_at,
  copilotSessionId: row.copilot_session_id ?? undefined,
  lastMessagePreview: row.last_message_preview ?? undefined,
});

const toMessage = (row: MessageRow, attachments: AttachmentSummary[]): ChatMessage => ({
  id: row.id,
  role: row.role,
  content: row.content,
  createdAt: row.created_at,
  ...(attachments.length > 0 ? { attachments } : {}),
});

export const createThread = (ownerId: string, input: CreateThreadInput = {}) => {
  const project = input.projectId ? getProjectRecord(ownerId, input.projectId) : null;
  if (input.projectId && !project) {
    return null;
  }

  const now = nowIso();
  const threadId = crypto.randomUUID();
  const model = input.model?.trim() || project?.default_model || env.defaultModel;
  const title = input.title?.trim() || 'New chat';

  db.prepare(
    `INSERT INTO threads (id, github_user_id, project_id, title, model, copilot_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(threadId, ownerId, project?.id ?? null, title, model, now, now);

  if (project) {
    touchProject(ownerId, project.id);
  }

  return getThread(ownerId, threadId);
};

export const listThreads = (ownerId: string, projectId?: string) => {
  const rows = db
    .prepare(
      `SELECT
         t.id,
         t.title,
         t.project_id,
         p.name AS project_name,
         t.model,
         t.updated_at,
         t.created_at,
         t.copilot_session_id,
         (
           SELECT substr(m.content, 1, 160)
           FROM messages m
           WHERE m.thread_id = t.id
           ORDER BY m.created_at DESC
           LIMIT 1
         ) AS last_message_preview
       FROM threads t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.github_user_id = ? AND (? IS NULL OR t.project_id = ?)
       ORDER BY t.updated_at DESC`,
    )
    .all(ownerId, projectId ?? null, projectId ?? null) as ThreadRow[];

  return rows.map(toSummary);
};

export const getThread = (ownerId: string, threadId: string) => {
  const row = db
    .prepare(
      `SELECT
         t.id,
         t.title,
         t.project_id,
         p.name AS project_name,
         t.model,
         t.updated_at,
         t.created_at,
         t.copilot_session_id,
         (
           SELECT substr(m.content, 1, 160)
           FROM messages m
           WHERE m.thread_id = t.id
           ORDER BY m.created_at DESC
           LIMIT 1
         ) AS last_message_preview
       FROM threads t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.github_user_id = ? AND t.id = ?`,
    )
    .get(ownerId, threadId) as ThreadRow | undefined;

  return row ? toSummary(row) : null;
};

const listThreadMessages = (threadId: string) =>
  db
    .prepare('SELECT id, thread_id, role, content, created_at, updated_at FROM messages WHERE thread_id = ? ORDER BY created_at ASC')
    .all(threadId) as MessageRow[];

export const getThreadDetail = (ownerId: string, threadId: string) => {
  const thread = getThread(ownerId, threadId);
  if (!thread) {
    return null;
  }

  const messages = listThreadMessages(threadId);
  const attachmentRows =
    messages.length > 0
      ? (db
          .prepare(
            `SELECT
               ma.message_id,
               a.id,
               a.name,
               a.mime_type,
               a.size,
               a.kind,
               a.uploaded_at,
               a.scope,
               a.knowledge_status
             FROM message_attachments ma
             JOIN attachments a ON a.id = ma.attachment_id
             WHERE ma.message_id IN (${messages.map(() => '?').join(',')})
             ORDER BY a.uploaded_at ASC`,
          )
          .all(...messages.map((message) => message.id)) as Array<{
          message_id: string;
          id: string;
          name: string;
          mime_type: string;
          size: number;
          kind: AttachmentSummary['kind'];
          uploaded_at: string;
          scope: AttachmentSummary['scope'];
          knowledge_status: AttachmentSummary['knowledgeStatus'];
        }>)
      : [];

  const attachmentsByMessage = new Map<string, AttachmentSummary[]>();
  for (const row of attachmentRows) {
    const bucket = attachmentsByMessage.get(row.message_id) ?? [];
    bucket.push({
      id: row.id,
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      kind: row.kind,
      uploadedAt: row.uploaded_at,
      scope: row.scope,
      knowledgeStatus: row.knowledge_status,
    });
    attachmentsByMessage.set(row.message_id, bucket);
  }

  return {
    ...thread,
    messages: messages.map((message) => toMessage(message, attachmentsByMessage.get(message.id) ?? [])),
  } satisfies ThreadDetail;
};

export const createMessage = (threadId: string, role: ChatRole, content: string) => {
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  db.prepare(
    'INSERT INTO messages (id, thread_id, role, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, threadId, role, content, timestamp, timestamp);
  db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(timestamp, threadId);
  return id;
};

export const updateMessage = (messageId: string, input: { content: string; role?: ChatRole }) => {
  const timestamp = nowIso();
  if (input.role) {
    db.prepare('UPDATE messages SET content = ?, role = ?, updated_at = ? WHERE id = ?').run(
      input.content,
      input.role,
      timestamp,
      messageId,
    );
    return;
  }

  db.prepare('UPDATE messages SET content = ?, updated_at = ? WHERE id = ?').run(input.content, timestamp, messageId);
};

export const linkMessageAttachments = (messageId: string, attachmentIds: string[]) => {
  const statement = db.prepare('INSERT OR IGNORE INTO message_attachments (message_id, attachment_id) VALUES (?, ?)');
  for (const attachmentId of attachmentIds) {
    statement.run(messageId, attachmentId);
  }
};

export const updateThreadSession = (threadId: string, sessionId: string) => {
  db.prepare('UPDATE threads SET copilot_session_id = ?, updated_at = ? WHERE id = ?').run(sessionId, nowIso(), threadId);
};

export const updateThreadModel = (threadId: string, model: string) => {
  db.prepare('UPDATE threads SET model = ?, updated_at = ? WHERE id = ?').run(model, nowIso(), threadId);
};

export const renameThreadIfPlaceholder = (threadId: string, title: string) => {
  db.prepare(
    `UPDATE threads
     SET title = ?, updated_at = ?
     WHERE id = ? AND (trim(title) = '' OR title = 'New chat')`,
  ).run(title, nowIso(), threadId);
};
