use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager.has_column("projects", "workspace_path").await? {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("projects"))
                        .add_column(ColumnDef::new(Alias::new("workspace_path")).string())
                        .to_owned(),
                )
                .await?;
        }

        if !manager.has_column("threads", "workspace_path").await? {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("threads"))
                        .add_column(ColumnDef::new(Alias::new("workspace_path")).string())
                        .to_owned(),
                )
                .await?;
        }

        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}
