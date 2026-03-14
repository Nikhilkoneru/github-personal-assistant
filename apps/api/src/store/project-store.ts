import crypto from 'node:crypto';

import type { ProjectDetail, ProjectSummary } from '@github-personal-assistant/shared';

import { db, nowIso } from '../db';

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  updated_at: string;
};

const LEGACY_SEED_PROJECT_IDS = ['launchpad', 'mobile-foundation'] as const;

const toProject = (row: ProjectRow): ProjectDetail => ({
  id: row.id,
  name: row.name,
  description: row.description,
  updatedAt: row.updated_at,
});

const pruneLegacySeedProjects = (ownerId: string) => {
  db.prepare(
    `DELETE FROM projects
     WHERE github_user_id = ?
       AND id IN (${LEGACY_SEED_PROJECT_IDS.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM threads WHERE threads.project_id = projects.id)`,
  ).run(ownerId, ...LEGACY_SEED_PROJECT_IDS);
};

export const listProjects = (ownerId: string): ProjectSummary[] => {
  pruneLegacySeedProjects(ownerId);
  const rows = db
    .prepare(
      `SELECT id, name, description, updated_at
       FROM projects
       WHERE github_user_id = ?
       ORDER BY updated_at DESC, name COLLATE NOCASE ASC`,
    )
    .all(ownerId) as ProjectRow[];
  return rows.map(toProject);
};

export const getProject = (ownerId: string, projectId: string): ProjectDetail | null => {
  const row = db
    .prepare(
      `SELECT id, name, description, updated_at
       FROM projects
       WHERE github_user_id = ? AND id = ?`,
    )
    .get(ownerId, projectId) as ProjectRow | undefined;
  return row ? toProject(row) : null;
};

export const getProjectRecord = (ownerId: string, projectId: string) =>
  (db
    .prepare(
      `SELECT id, name, description, updated_at
       FROM projects
       WHERE github_user_id = ? AND id = ?`,
    )
    .get(ownerId, projectId) as ProjectRow | undefined) ?? null;

export const createProject = (ownerId: string, input: { name: string; description?: string }): ProjectDetail => {
  const project: ProjectDetail = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    description: input.description?.trim() || 'Project group',
    updatedAt: nowIso(),
  };

  db.prepare(`
    INSERT INTO projects (
      id, github_user_id, name, description, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    project.id,
    ownerId,
    project.name,
    project.description,
    project.updatedAt,
    project.updatedAt,
  );

  return project;
};

export const touchProject = (ownerId: string, projectId: string) => {
  db.prepare('UPDATE projects SET updated_at = ? WHERE github_user_id = ? AND id = ?').run(nowIso(), ownerId, projectId);
};
