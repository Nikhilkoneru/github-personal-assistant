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
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO projects (id, github_user_id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![id, owner_id, name, description, now, now],
    ).unwrap();
    ProjectSummary { id, name: name.to_string(), description: description.to_string(), updated_at: now }
}

pub fn list_projects(db: &Database, owner_id: &str) -> Vec<ProjectSummary> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, name, description, updated_at FROM projects WHERE github_user_id = ?1 ORDER BY updated_at DESC")
        .unwrap();
    stmt.query_map([owner_id], |row| {
        Ok(ProjectSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn get_project(db: &Database, owner_id: &str, project_id: &str) -> Option<ProjectSummary> {
    let conn = db.conn.lock().unwrap();
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

pub fn touch_project(db: &Database, owner_id: &str, project_id: &str) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute(
        "UPDATE projects SET updated_at = ?1 WHERE id = ?2 AND github_user_id = ?3",
        rusqlite::params![now_iso(), project_id, owner_id],
    );
}
