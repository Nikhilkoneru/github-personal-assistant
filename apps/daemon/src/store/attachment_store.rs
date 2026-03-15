use std::path::PathBuf;

use serde::Serialize;
use uuid::Uuid;

use crate::db::{now_iso, Database};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSummary {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
    pub kind: String,
    pub uploaded_at: String,
}

fn classify_kind(mime_type: &str) -> &str {
    if mime_type.starts_with("image/") {
        "image"
    } else if mime_type == "application/pdf" || mime_type.starts_with("text/") {
        "document"
    } else if mime_type.starts_with("audio/") {
        "audio"
    } else if mime_type.starts_with("video/") {
        "video"
    } else {
        "other"
    }
}

pub fn save_attachment(
    db: &Database,
    media_root: &std::path::Path,
    owner_id: &str,
    thread_id: Option<&str>,
    original_name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> anyhow::Result<AttachmentSummary> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let kind = classify_kind(mime_type);
    let ext = original_name
        .rsplit('.')
        .next()
        .filter(|e| e.len() <= 10)
        .unwrap_or("bin");
    let file_name = format!("{id}.{ext}");
    let file_path = media_root.join(&file_name);
    std::fs::write(&file_path, bytes)?;

    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO attachments (id, github_user_id, thread_id, name, mime_type, size, kind, file_path, created_at, updated_at, uploaded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            id, owner_id, thread_id, original_name, mime_type,
            bytes.len() as i64, kind, file_path.to_string_lossy().to_string(),
            now, now, now
        ],
    )?;

    Ok(AttachmentSummary {
        id,
        name: original_name.to_string(),
        mime_type: mime_type.to_string(),
        size: bytes.len() as i64,
        kind: kind.to_string(),
        uploaded_at: now,
    })
}

pub fn get_attachment_file_path(db: &Database, owner_id: &str, attachment_id: &str) -> Option<PathBuf> {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT file_path FROM attachments WHERE id = ?1 AND github_user_id = ?2",
        rusqlite::params![attachment_id, owner_id],
        |row| {
            let p: String = row.get(0)?;
            Ok(PathBuf::from(p))
        },
    )
    .ok()
}

pub fn list_thread_attachments(db: &Database, owner_id: &str, thread_id: &str) -> Vec<AttachmentSummary> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, name, mime_type, size, kind, uploaded_at FROM attachments WHERE github_user_id = ?1 AND thread_id = ?2 ORDER BY uploaded_at DESC",
        )
        .unwrap();
    stmt.query_map(rusqlite::params![owner_id, thread_id], |row| {
        Ok(AttachmentSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            mime_type: row.get(2)?,
            size: row.get(3)?,
            kind: row.get(4)?,
            uploaded_at: row.get(5)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}
