use serde::Serialize;
use uuid::Uuid;

use crate::db::{now_iso, Database};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub updated_at: String,
}

pub fn create_project(db: &Database, owner_id: &str, name: &str, description: &str) -> ProjectSummary {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    if let Ok(conn) = db.lock() {
        let _ = conn.execute(
            "INSERT INTO projects (id, github_user_id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, owner_id, name, description, now, now],
        );
    }
    ProjectSummary {
        id,
        name: name.to_string(),
        description: description.to_string(),
        updated_at: now,
    }
}

pub fn list_projects(db: &Database, owner_id: &str) -> Vec<ProjectSummary> {
    let Ok(conn) = db.lock() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, name, description, updated_at FROM projects WHERE github_user_id = ?1 ORDER BY updated_at DESC",
    ) else {
        return Vec::new();
    };
    stmt.query_map([owner_id], |row| {
        Ok(ProjectSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })
    .map(|rows| rows.filter_map(|row| row.ok()).collect())
    .unwrap_or_default()
}

pub fn get_project(db: &Database, owner_id: &str, project_id: &str) -> Option<ProjectSummary> {
    let conn = db.lock().ok()?;
    conn.query_row(
        "SELECT id, name, description, updated_at FROM projects WHERE github_user_id = ?1 AND id = ?2",
        rusqlite::params![owner_id, project_id],
        |row| {
            Ok(ProjectSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )
    .ok()
}


