use sea_orm_migration::prelude::*;

const INITIAL_SCHEMA_SQL: &str = include_str!("../../sql/schema.sql");

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "migrations"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(INITIAL_SCHEMA_SQL)
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                DROP TABLE IF EXISTS app_preferences;
                DROP TABLE IF EXISTS message_attachment_set_items;
                DROP TABLE IF EXISTS message_attachment_sets;
                DROP TABLE IF EXISTS attachments;
                DROP TABLE IF EXISTS threads;
                DROP TABLE IF EXISTS projects;
                DROP TABLE IF EXISTS device_auth_flows;
                DROP TABLE IF EXISTS oauth_states;
                DROP TABLE IF EXISTS app_sessions;
                DROP TABLE IF EXISTS users;
                "#,
            )
            .await?;
        Ok(())
    }
}
