import crypto from 'node:crypto';

import type { ProjectDetail, ProjectSummary } from '@github-personal-assistant/shared';

import { env } from '../config';
import { db, nowIso } from '../db';

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  default_model: string;
  instructions: string;
  updated_at: string;
  created_at: string;
  ragflow_dataset_id: string | null;
  ragflow_dataset_name: string | null;
};

const toDetail = (row: ProjectRow): ProjectDetail => ({
  id: row.id,
  name: row.name,
  description: row.description,
  defaultModel: row.default_model,
  instructions: row.instructions,
  updatedAt: row.updated_at,
});

const toSummary = (row: ProjectRow): ProjectSummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  defaultModel: row.default_model,
  updatedAt: row.updated_at,
});

const createSeedProjects = (ownerId: string) => {
  const now = nowIso();
  const rows = [
    {
      id: 'launchpad',
      name: 'Launchpad',
      description: 'Product strategy, architecture, and launch planning for Github Personal Assistant.',
      defaultModel: env.defaultModel,
      instructions:
        'You are the launchpad assistant for Github Personal Assistant. Prioritize product strategy, delivery sequencing, and pragmatic implementation details.',
    },
    {
      id: 'mobile-foundation',
      name: 'Mobile foundation',
      description: 'Expo client work for web and Android, including UX, auth, and streaming chat.',
      defaultModel: env.defaultModel,
      instructions:
        'You are helping implement the Expo client. Prioritize mobile-friendly UX, performance, and platform-safe decisions.',
    },
  ];

  const insert = db.prepare(`
    INSERT INTO projects (
      id, github_user_id, name, description, default_model, instructions,
      ragflow_dataset_id, ragflow_dataset_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
  `);

  for (const row of rows) {
    insert.run(row.id, ownerId, row.name, row.description, row.defaultModel, row.instructions, now, now);
  }
};

const ensureProjects = (ownerId: string) => {
  const row = db.prepare('SELECT COUNT(*) AS count FROM projects WHERE github_user_id = ?').get(ownerId) as { count: number };
  if (row.count === 0) {
    createSeedProjects(ownerId);
  }
};

export const listProjects = (ownerId: string) => {
  ensureProjects(ownerId);
  const rows = db
    .prepare(
      `SELECT id, name, description, default_model, instructions, updated_at, created_at, ragflow_dataset_id, ragflow_dataset_name
       FROM projects WHERE github_user_id = ? ORDER BY updated_at DESC`,
    )
    .all(ownerId) as ProjectRow[];
  return rows.map(toSummary);
};

export const getProject = (ownerId: string, projectId: string) => {
  ensureProjects(ownerId);
  const row = db
    .prepare(
      `SELECT id, name, description, default_model, instructions, updated_at, created_at, ragflow_dataset_id, ragflow_dataset_name
       FROM projects WHERE github_user_id = ? AND id = ?`,
    )
    .get(ownerId, projectId) as ProjectRow | undefined;
  return row ? toDetail(row) : null;
};

export const getProjectRecord = (ownerId: string, projectId: string) => {
  ensureProjects(ownerId);
  return (
    (db
      .prepare(
        `SELECT id, name, description, default_model, instructions, updated_at, created_at, ragflow_dataset_id, ragflow_dataset_name
         FROM projects WHERE github_user_id = ? AND id = ?`,
      )
      .get(ownerId, projectId) as ProjectRow | undefined) ?? null
  );
};

export const createProject = (ownerId: string, input: { name: string; description?: string }) => {
  ensureProjects(ownerId);
  const project: ProjectDetail = {
    id: crypto.randomUUID(),
    name: input.name,
    description: input.description?.trim() || 'New project',
    defaultModel: env.defaultModel,
    updatedAt: nowIso(),
    instructions:
      'You are the default project assistant. Be concise, implementation-oriented, and prefer safe backend-managed workflows.',
  };

  db.prepare(`
    INSERT INTO projects (
      id, github_user_id, name, description, default_model, instructions,
      ragflow_dataset_id, ragflow_dataset_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
  `).run(
    project.id,
    ownerId,
    project.name,
    project.description,
    project.defaultModel,
    project.instructions,
    project.updatedAt,
    project.updatedAt,
  );

  return project;
};

export const setProjectRagFlowDataset = (ownerId: string, projectId: string, input: { datasetId: string; datasetName: string }) => {
  db.prepare(
    'UPDATE projects SET ragflow_dataset_id = ?, ragflow_dataset_name = ?, updated_at = ? WHERE github_user_id = ? AND id = ?',
  ).run(input.datasetId, input.datasetName, nowIso(), ownerId, projectId);
};

export const touchProject = (ownerId: string, projectId: string) => {
  db.prepare('UPDATE projects SET updated_at = ? WHERE github_user_id = ? AND id = ?').run(nowIso(), ownerId, projectId);
};
