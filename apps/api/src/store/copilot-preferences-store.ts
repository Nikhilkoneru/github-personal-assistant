import type { CopilotApprovalMode, CopilotPreferences } from '@github-personal-assistant/shared';

import { db, nowIso } from '../db.js';

const APPROVAL_MODE_KEY = 'copilot_approval_mode';

const parseApprovalMode = (value: unknown): CopilotApprovalMode =>
  value === 'safer-defaults' ? 'safer-defaults' : 'approve-all';

export const getCopilotPreferences = (): CopilotPreferences => {
  const row = db
    .prepare('SELECT value FROM app_preferences WHERE key = ?')
    .get(APPROVAL_MODE_KEY) as { value?: string } | undefined;

  return {
    approvalMode: parseApprovalMode(row?.value),
  };
};

export const setCopilotApprovalMode = (approvalMode: CopilotApprovalMode): CopilotPreferences => {
  db.prepare(
    `INSERT INTO app_preferences (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(APPROVAL_MODE_KEY, approvalMode, nowIso());

  return getCopilotPreferences();
};
