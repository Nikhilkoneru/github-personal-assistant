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

#[derive(Clone)]
pub struct MessageAttachmentSet {
    pub user_message_index: usize,
    pub attachments: Vec<AttachmentSummary>,
}

#[derive(Clone)]
pub struct AttachmentRecord {
    pub name: String,
    pub mime_type: String,
    pub file_path: String,
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

    let conn = db.lock()?;
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

pub fn get_attachments_by_ids(
    db: &Database,
    owner_id: &str,
    thread_id: Option<&str>,
    attachment_ids: &[String],
) -> Vec<AttachmentRecord> {
    let Ok(conn) = db.lock() else {
        return Vec::new();
    };

    attachment_ids
        .iter()
        .filter_map(|attachment_id| {
            conn.query_row(
                "SELECT name, mime_type, file_path
                 FROM attachments
                 WHERE id = ?1
                   AND github_user_id = ?2
                   AND (?3 IS NULL OR thread_id IS NULL OR thread_id = ?3)",
                rusqlite::params![attachment_id, owner_id, thread_id],
                |row| {
                    Ok(AttachmentRecord {
                        name: row.get(0)?,
                        mime_type: row.get(1)?,
                        file_path: row.get(2)?,
                    })
                },
            )
            .ok()
        })
        .collect()
}

pub fn save_message_attachments(
    db: &Database,
    thread_id: &str,
    user_message_index: usize,
    attachment_ids: &[String],
) -> anyhow::Result<()> {
    if attachment_ids.is_empty() {
        return Ok(());
    }

    let mut conn = db.lock()?;
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM message_attachment_sets
         WHERE thread_id = ?1 AND user_message_index = ?2",
        rusqlite::params![thread_id, user_message_index as i64],
    )?;

    let set_id = Uuid::new_v4().to_string();
    let now = now_iso();
    tx.execute(
        "INSERT INTO message_attachment_sets (id, thread_id, user_message_index, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![set_id, thread_id, user_message_index as i64, now],
    )?;

    for (position, attachment_id) in attachment_ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO message_attachment_set_items (message_attachment_set_id, attachment_id, position)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![set_id, attachment_id, position as i64],
        )?;
    }

    tx.commit()?;
    Ok(())
}

pub fn list_message_attachments(
    db: &Database,
    thread_id: &str,
) -> anyhow::Result<Vec<MessageAttachmentSet>> {
    let conn = db.lock()?;
    let mut sets_stmt = conn.prepare(
        "SELECT id, user_message_index
         FROM message_attachment_sets
         WHERE thread_id = ?1
         ORDER BY user_message_index ASC, created_at ASC",
    )?;
    let set_rows = sets_stmt.query_map(rusqlite::params![thread_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;

    let mut sets = Vec::new();
    for row in set_rows {
        let (set_id, user_message_index) = row?;
        let mut attachments_stmt = conn.prepare(
            "SELECT a.id, a.name, a.mime_type, a.size, a.kind, a.uploaded_at
             FROM message_attachment_set_items items
             JOIN attachments a ON a.id = items.attachment_id
             WHERE items.message_attachment_set_id = ?1
             ORDER BY items.position ASC",
        )?;
        let attachments = attachments_stmt
            .query_map(rusqlite::params![set_id], |attachment_row| {
                Ok(AttachmentSummary {
                    id: attachment_row.get(0)?,
                    name: attachment_row.get(1)?,
                    mime_type: attachment_row.get(2)?,
                    size: attachment_row.get(3)?,
                    kind: attachment_row.get(4)?,
                    uploaded_at: attachment_row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        sets.push(MessageAttachmentSet {
            user_message_index: user_message_index as usize,
            attachments,
        });
    }

    Ok(sets)
}
