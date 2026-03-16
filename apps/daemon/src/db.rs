use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use crate::config::Config;

const SCHEMA_SQL: &str = include_str!("../sql/schema.sql");

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn open(config: &Config) -> anyhow::Result<Self> {
        if let Some(parent) = config.database_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if let Some(parent) = config.log_file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::create_dir_all(&config.media_root)?;

        let conn = Connection::open(&config.database_path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute_batch("PRAGMA busy_timeout = 5000;")?;
        conn.execute_batch(SCHEMA_SQL)?;

        Ok(Database {
            conn: Mutex::new(conn),
        })
    }

    pub fn lock(&self) -> anyhow::Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| anyhow::anyhow!("Database connection lock poisoned"))
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

