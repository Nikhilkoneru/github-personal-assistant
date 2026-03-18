use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager.has_table("canvases").await? {
            manager
                .create_table(
                    Table::create()
                        .table(Alias::new("canvases"))
                        .if_not_exists()
                        .col(
                            ColumnDef::new(Alias::new("id"))
                                .string()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(Alias::new("thread_id")).string().not_null())
                        .col(ColumnDef::new(Alias::new("title")).string().not_null())
                        .col(ColumnDef::new(Alias::new("kind")).string().not_null())
                        .col(ColumnDef::new(Alias::new("content")).text().not_null())
                        .col(ColumnDef::new(Alias::new("created_by_user_message_index")).integer())
                        .col(ColumnDef::new(Alias::new("last_updated_by_user_message_index")).integer())
                        .col(ColumnDef::new(Alias::new("created_at")).string().not_null())
                        .col(ColumnDef::new(Alias::new("updated_at")).string().not_null())
                        .foreign_key(
                            ForeignKey::create()
                                .name("fk_canvases_thread")
                                .from(Alias::new("canvases"), Alias::new("thread_id"))
                                .to(Alias::new("threads"), Alias::new("id"))
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .to_owned(),
                )
                .await?;
        }

        if !manager.has_index("canvases", "idx_canvases_thread").await? {
            manager
                .create_index(
                    Index::create()
                        .name("idx_canvases_thread")
                        .table(Alias::new("canvases"))
                        .col(Alias::new("thread_id"))
                        .col(Alias::new("updated_at"))
                        .to_owned(),
                )
                .await?;
        }

        if !manager.has_table("canvas_revisions").await? {
            manager
                .create_table(
                    Table::create()
                        .table(Alias::new("canvas_revisions"))
                        .if_not_exists()
                        .col(
                            ColumnDef::new(Alias::new("id"))
                                .string()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(Alias::new("canvas_id")).string().not_null())
                        .col(ColumnDef::new(Alias::new("revision_number")).integer().not_null())
                        .col(ColumnDef::new(Alias::new("content")).text().not_null())
                        .col(ColumnDef::new(Alias::new("created_at")).string().not_null())
                        .col(ColumnDef::new(Alias::new("source_user_message_index")).integer())
                        .foreign_key(
                            ForeignKey::create()
                                .name("fk_canvas_revisions_canvas")
                                .from(Alias::new("canvas_revisions"), Alias::new("canvas_id"))
                                .to(Alias::new("canvases"), Alias::new("id"))
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .index(
                            Index::create()
                                .name("uq_canvas_revisions_number")
                                .unique()
                                .col(Alias::new("canvas_id"))
                                .col(Alias::new("revision_number")),
                        )
                        .to_owned(),
                )
                .await?;
        }

        if !manager
            .has_index("canvas_revisions", "idx_canvas_revisions_canvas")
            .await?
        {
            manager
                .create_index(
                    Index::create()
                        .name("idx_canvas_revisions_canvas")
                        .table(Alias::new("canvas_revisions"))
                        .col(Alias::new("canvas_id"))
                        .col(Alias::new("revision_number"))
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
