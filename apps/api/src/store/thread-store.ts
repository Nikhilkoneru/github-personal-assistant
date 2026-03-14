import crypto from 'node:crypto';

import type { CreateThreadInput, ReasoningEffort, ThreadDetail, ThreadSummary, UpdateThreadInput } from '@github-personal-assistant/shared';

import { env } from '../config';
import { db, nowIso } from '../db';
import { getProjectRecord, touchProject } from './project-store';

type ThreadRow = {
  id: string;
  title: string;
  project_id: string | null;
  project_name: string | null;
  model: string;
  reasoning_effort: ReasoningEffort | null;
  updated_at: string;
  created_at: string;
  copilot_session_id: string | null;
  last_message_preview: string | null;
};

const summarizePreview = (value: string) => {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > 160 ? `${singleLine.slice(0, 160)}...` : singleLine;
};

const toSummary = (row: ThreadRow): ThreadSummary => ({
  id: row.id,
  title: row.title,
  projectId: row.project_id ?? undefined,
  projectName: row.project_name ?? undefined,
  model: row.model,
  reasoningEffort: row.reasoning_effort ?? undefined,
  updatedAt: row.updated_at,
  createdAt: row.created_at,
  copilotSessionId: row.copilot_session_id ?? undefined,
  lastMessagePreview: row.last_message_preview ?? undefined,
});

export const createThread = (ownerId: string, input: CreateThreadInput = {}) => {
  const project = input.projectId ? getProjectRecord(ownerId, input.projectId) : null;
  if (input.projectId && !project) {
    return null;
  }

  const now = nowIso();
  const threadId = crypto.randomUUID();
  const model = input.model?.trim() || env.defaultModel;
  const title = input.title?.trim() || 'New chat';

  db.prepare(
    `INSERT INTO threads (id, github_user_id, project_id, title, model, reasoning_effort, last_message_preview, copilot_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(threadId, ownerId, project?.id ?? null, title, model, input.reasoningEffort ?? null, now, now);

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
         t.reasoning_effort,
         t.updated_at,
         t.created_at,
         t.copilot_session_id,
         t.last_message_preview
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
         t.reasoning_effort,
         t.updated_at,
         t.created_at,
         t.copilot_session_id,
         t.last_message_preview
       FROM threads t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.github_user_id = ? AND t.id = ?`,
    )
    .get(ownerId, threadId) as ThreadRow | undefined;

  return row ? toSummary(row) : null;
};

export const getThreadDetail = (ownerId: string, threadId: string) => {
  const thread = getThread(ownerId, threadId);
  if (!thread) {
    return null;
  }

  return {
    ...thread,
    messages: [],
  } satisfies ThreadDetail;
};

export const updateThreadSession = (threadId: string, sessionId: string) => {
  db.prepare('UPDATE threads SET copilot_session_id = ?, updated_at = ? WHERE id = ?').run(sessionId, nowIso(), threadId);
};

export const updateThreadPreview = (threadId: string, preview: string) => {
  db.prepare('UPDATE threads SET last_message_preview = ?, updated_at = ? WHERE id = ?').run(
    summarizePreview(preview),
    nowIso(),
    threadId,
  );
};

export const updateThread = (ownerId: string, threadId: string, input: UpdateThreadInput) => {
  const thread = getThread(ownerId, threadId);
  if (!thread) {
    return null;
  }

  const nextProjectId = input.projectId === undefined ? thread.projectId ?? null : input.projectId ?? null;
  const targetProject = nextProjectId ? getProjectRecord(ownerId, nextProjectId) : null;
  if (nextProjectId && !targetProject) {
    return null;
  }

  const model = input.model?.trim() || thread.model;
  const reasoningEffort =
    input.reasoningEffort === undefined
      ? thread.reasoningEffort ?? null
      : input.reasoningEffort ?? null;
  const timestamp = nowIso();

  db.prepare(
    'UPDATE threads SET project_id = ?, model = ?, reasoning_effort = ?, updated_at = ? WHERE id = ? AND github_user_id = ?',
  ).run(targetProject?.id ?? null, model, reasoningEffort, timestamp, threadId, ownerId);

  if (thread.projectId && thread.projectId !== targetProject?.id) {
    touchProject(ownerId, thread.projectId);
  }
  if (targetProject) {
    touchProject(ownerId, targetProject.id);
  }

  return getThread(ownerId, threadId);
};

export const moveThreadToProject = (ownerId: string, threadId: string, projectId?: string | null) =>
  updateThread(ownerId, threadId, { projectId: projectId ?? null });

export const renameThreadIfPlaceholder = (threadId: string, title: string) => {
  db.prepare(
    `UPDATE threads
     SET title = ?, updated_at = ?
     WHERE id = ? AND (trim(title) = '' OR title = 'New chat')`,
  ).run(title, nowIso(), threadId);
};
