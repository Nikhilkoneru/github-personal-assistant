use serde::Serialize;
use uuid::Uuid;

use crate::db::{now_iso, Database};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub updated_at: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copilot_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_preview: Option<String>,
}

pub fn create_thread(
    db: &Database,
    owner_id: &str,
    default_model: &str,
    project_id: Option<&str>,
    title: Option<&str>,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Option<ThreadSummary> {
    if let Some(pid) = project_id {
        let conn = db.lock().ok()?;
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM projects WHERE id = ?1 AND github_user_id = ?2",
                rusqlite::params![pid, owner_id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return None;
        }
    }

    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let actual_model = model.filter(|m| !m.is_empty()).unwrap_or(default_model);
    let actual_title = title.filter(|t| !t.is_empty()).unwrap_or("New chat");

    let conn = db.lock().ok()?;
    conn.execute(
        "INSERT INTO threads (id, github_user_id, project_id, title, model, reasoning_effort, last_message_preview, copilot_session_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?8)",
        rusqlite::params![id, owner_id, project_id, actual_title, actual_model, reasoning_effort, now, now],
    )
    .ok()?;
    drop(conn);

    get_thread(db, owner_id, &id)
}

pub fn list_threads(db: &Database, owner_id: &str, project_id: Option<&str>) -> Vec<ThreadSummary> {
    let Ok(conn) = db.lock() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT t.id, t.title, t.project_id, p.name, t.model, t.reasoning_effort, t.updated_at, t.created_at, t.copilot_session_id, t.last_message_preview
         FROM threads t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.github_user_id = ?1 AND (?2 IS NULL OR t.project_id = ?2)
         ORDER BY t.updated_at DESC",
    ) else {
        return Vec::new();
    };
    stmt.query_map(rusqlite::params![owner_id, project_id], |row| {
        Ok(ThreadSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            project_id: row.get(2)?,
            project_name: row.get(3)?,
            model: row.get(4)?,
            reasoning_effort: row.get(5)?,
            updated_at: row.get(6)?,
            created_at: row.get(7)?,
            copilot_session_id: row.get(8)?,
            last_message_preview: row.get(9)?,
        })
    })
    .map(|rows| rows.filter_map(|row| row.ok()).collect())
    .unwrap_or_default()
}

pub fn get_thread(db: &Database, owner_id: &str, thread_id: &str) -> Option<ThreadSummary> {
    let conn = db.lock().ok()?;
    conn.query_row(
        "SELECT t.id, t.title, t.project_id, p.name, t.model, t.reasoning_effort, t.updated_at, t.created_at, t.copilot_session_id, t.last_message_preview
         FROM threads t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.github_user_id = ?1 AND t.id = ?2",
        rusqlite::params![owner_id, thread_id],
        |row| {
            Ok(ThreadSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                project_id: row.get(2)?,
                project_name: row.get(3)?,
                model: row.get(4)?,
                reasoning_effort: row.get(5)?,
                updated_at: row.get(6)?,
                created_at: row.get(7)?,
                copilot_session_id: row.get(8)?,
                last_message_preview: row.get(9)?,
            })
        },
    )
    .ok()
}

pub fn update_thread_session(db: &Database, thread_id: &str, session_id: &str) {
    if let Ok(conn) = db.lock() {
        let _ = conn.execute(
            "UPDATE threads SET copilot_session_id = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![session_id, now_iso(), thread_id],
        );
    }
}

pub fn update_thread_preview(db: &Database, thread_id: &str, preview: &str) {
    let single_line = preview.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated = if single_line.len() > 160 {
        format!("{}...", &single_line[..160])
    } else {
        single_line
    };
    if let Ok(conn) = db.lock() {
        let _ = conn.execute(
            "UPDATE threads SET last_message_preview = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![truncated, now_iso(), thread_id],
        );
    }
}

pub fn update_thread(
    db: &Database,
    owner_id: &str,
    thread_id: &str,
    project_id: Option<Option<&str>>,
    model: Option<&str>,
    reasoning_effort: Option<Option<&str>>,
) -> Option<ThreadSummary> {
    let thread = get_thread(db, owner_id, thread_id)?;
    let actual_model = model.filter(|m| !m.is_empty()).unwrap_or(&thread.model);
    let actual_project_id = match project_id {
        Some(pid) => pid,
        None => thread.project_id.as_deref(),
    };
    let actual_reasoning = match reasoning_effort {
        Some(re) => re,
        None => thread.reasoning_effort.as_deref(),
    };

    if let Some(pid) = actual_project_id {
        let conn = db.lock().ok()?;
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM projects WHERE id = ?1 AND github_user_id = ?2",
                rusqlite::params![pid, owner_id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return None;
        }
    }

    let conn = db.lock().ok()?;
    let _ = conn.execute(
        "UPDATE threads SET project_id = ?1, model = ?2, reasoning_effort = ?3, updated_at = ?4 WHERE id = ?5 AND github_user_id = ?6",
        rusqlite::params![actual_project_id, actual_model, actual_reasoning, now_iso(), thread_id, owner_id],
    );
    drop(conn);

    get_thread(db, owner_id, thread_id)
}

pub fn rename_thread_if_placeholder(db: &Database, thread_id: &str, title: &str) {
    if let Ok(conn) = db.lock() {
        let _ = conn.execute(
            "UPDATE threads SET title = ?1, updated_at = ?2 WHERE id = ?3 AND (trim(title) = '' OR title = 'New chat')",
            rusqlite::params![title, now_iso(), thread_id],
        );
    }
}
