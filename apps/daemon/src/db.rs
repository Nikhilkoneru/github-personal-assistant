use std::time::Duration;

use sea_orm::{DatabaseConnection, SqlxSqliteConnector};
use sea_orm_migration::MigratorTrait;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use crate::config::Config;

pub mod entities;

pub struct Database {
    conn: DatabaseConnection,
}

impl Database {
    pub async fn open(config: &Config) -> anyhow::Result<Self> {
        if let Some(parent) = config.database_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if let Some(parent) = config.log_file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::create_dir_all(&config.media_root)?;

        let options = SqliteConnectOptions::new()
            .filename(&config.database_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .connect_with(options)
            .await?;
        let conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(pool);

        migration::Migrator::up(&conn, None).await?;

        Ok(Self { conn })
    }

    pub fn connection(&self) -> &DatabaseConnection {
        &self.conn
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use sea_orm::EntityTrait;

    use super::*;

    #[tokio::test]
    async fn opens_database_and_applies_schema() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::config::test_config(temp.path());

        let db = Database::open(&config).await.unwrap();

        let users = crate::db::entities::users::Entity::find()
            .all(db.connection())
            .await
            .unwrap();
        let prefs = crate::db::entities::app_preferences::Entity::find()
            .all(db.connection())
            .await
            .unwrap();

        assert!(users.is_empty());
        assert!(prefs.is_empty());
        assert!(config.database_path.exists());
    }
}
