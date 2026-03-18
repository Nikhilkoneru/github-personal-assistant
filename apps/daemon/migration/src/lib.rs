pub use sea_orm_migration::prelude::*;

mod m20260316_000001_initial_schema;
mod m20260318_000002_workspace_metadata;
mod m20260318_000003_canvas_artifacts;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260316_000001_initial_schema::Migration),
            Box::new(m20260318_000002_workspace_metadata::Migration),
            Box::new(m20260318_000003_canvas_artifacts::Migration),
        ]
    }
}
