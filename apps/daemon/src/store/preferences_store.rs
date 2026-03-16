use serde::Serialize;

use crate::db::{now_iso, Database};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopilotPreferences {
    pub approval_mode: String,
}

pub fn get_preferences(db: &Database) -> CopilotPreferences {
    let mode = db
        .lock()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT value FROM app_preferences WHERE key = 'copilot_approval_mode'",
                [],
                |row| row.get(0),
            )
            .ok()
        })
        .unwrap_or_else(|| "approve-all".to_string());
    CopilotPreferences {
        approval_mode: mode,
    }
}

pub fn set_approval_mode(db: &Database, mode: &str) -> CopilotPreferences {
    if let Ok(conn) = db.lock() {
        let _ = conn.execute(
            "INSERT INTO app_preferences (key, value, updated_at) VALUES ('copilot_approval_mode', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![mode, now_iso()],
        );
    }
    CopilotPreferences {
        approval_mode: mode.to_string(),
    }
}
