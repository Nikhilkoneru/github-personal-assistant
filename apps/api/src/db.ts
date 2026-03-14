import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { env } from './config';

const ensureDirectory = (targetPath: string) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
};

ensureDirectory(env.databasePath);
fs.mkdirSync(env.mediaRoot, { recursive: true });

export const db = new DatabaseSync(env.databasePath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  github_user_id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_sessions (
  session_token TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL REFERENCES users(github_user_id) ON DELETE CASCADE,
  github_access_token TEXT NOT NULL,
  auth_mode TEXT NOT NULL DEFAULT 'github-device',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(github_user_id);
CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON app_sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  redirect_uri TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_auth_flows (
  flow_id TEXT PRIMARY KEY,
  device_code TEXT NOT NULL,
  user_code TEXT NOT NULL,
  verification_uri TEXT NOT NULL,
  verification_uri_complete TEXT,
  expires_at TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  next_poll_at TEXT NOT NULL,
  status TEXT NOT NULL,
  session_token TEXT REFERENCES app_sessions(session_token) ON DELETE SET NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL REFERENCES users(github_user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(github_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL REFERENCES users(github_user_id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT,
  last_message_preview TEXT,
  copilot_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(github_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL REFERENCES users(github_user_id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  pdf_context_file_path TEXT,
  pdf_extraction TEXT,
  pdf_page_count INTEGER,
  pdf_title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(github_user_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS app_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

const ensureColumn = (table: string, column: string, alterSql: string) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(alterSql);
  }
};

ensureColumn('app_sessions', 'auth_mode', "ALTER TABLE app_sessions ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'github-device';");
ensureColumn('threads', 'reasoning_effort', 'ALTER TABLE threads ADD COLUMN reasoning_effort TEXT;');
ensureColumn('threads', 'last_message_preview', 'ALTER TABLE threads ADD COLUMN last_message_preview TEXT;');

export const nowIso = () => new Date().toISOString();
