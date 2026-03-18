use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter,
    QueryOrder, Set, TransactionTrait,
};
use serde::Serialize;
use uuid::Uuid;

use crate::db::entities::{canvas_revisions, canvases};
use crate::db::{now_iso, Database};

pub fn normalize_canvas_title(title: &str) -> anyhow::Result<String> {
    let trimmed = title.trim();
    if trimmed.len() < 2 || trimmed.len() > 120 {
        anyhow::bail!("Canvas title must be 2-120 characters.");
    }
    Ok(trimmed.to_string())
}

pub fn normalize_canvas_kind(kind: &str) -> anyhow::Result<String> {
    let trimmed = kind.trim();
    if trimmed.is_empty() || trimmed.len() > 40 {
        anyhow::bail!("Canvas kind must be 1-40 characters.");
    }
    Ok(trimmed.to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDetail {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    pub kind: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_user_message_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated_by_user_message_index: Option<usize>,
    pub created_at: String,
    pub updated_at: String,
    pub revision_count: usize,
    pub latest_revision_number: usize,
}

fn to_canvas_detail(
    canvas: canvases::Model,
    revision_count: usize,
    latest_revision_number: usize,
) -> CanvasDetail {
    CanvasDetail {
        id: canvas.id,
        thread_id: canvas.thread_id,
        title: canvas.title,
        kind: canvas.kind,
        content: canvas.content,
        created_by_user_message_index: canvas.created_by_user_message_index.map(|value| value as usize),
        last_updated_by_user_message_index: canvas
            .last_updated_by_user_message_index
            .map(|value| value as usize),
        created_at: canvas.created_at,
        updated_at: canvas.updated_at,
        revision_count,
        latest_revision_number,
    }
}

async fn canvas_revision_stats(
    db: &Database,
    canvas_id: &str,
) -> anyhow::Result<(usize, usize)> {
    let revisions = canvas_revisions::Entity::find()
        .filter(canvas_revisions::Column::CanvasId.eq(canvas_id.to_string()))
        .order_by_desc(canvas_revisions::Column::RevisionNumber)
        .all(db.connection())
        .await?;
    let revision_count = revisions.len();
    let latest_revision_number = revisions
        .first()
        .map(|revision| revision.revision_number as usize)
        .unwrap_or(0);
    Ok((revision_count, latest_revision_number))
}

async fn create_revision(
    txn: &sea_orm::DatabaseTransaction,
    canvas_id: &str,
    revision_number: usize,
    content: &str,
    source_user_message_index: Option<usize>,
) -> anyhow::Result<()> {
    canvas_revisions::ActiveModel {
        id: Set(Uuid::new_v4().to_string()),
        canvas_id: Set(canvas_id.to_string()),
        revision_number: Set(revision_number as i64),
        content: Set(content.to_string()),
        created_at: Set(now_iso()),
        source_user_message_index: Set(source_user_message_index.map(|value| value as i64)),
    }
    .insert(txn)
    .await?;
    Ok(())
}

pub async fn list_canvases(db: &Database, thread_id: &str) -> anyhow::Result<Vec<CanvasDetail>> {
    let records = canvases::Entity::find()
        .filter(canvases::Column::ThreadId.eq(thread_id.to_string()))
        .order_by_desc(canvases::Column::UpdatedAt)
        .all(db.connection())
        .await?;

    let mut canvases_out = Vec::with_capacity(records.len());
    for canvas in records {
        let (revision_count, latest_revision_number) = canvas_revision_stats(db, &canvas.id).await?;
        canvases_out.push(to_canvas_detail(
            canvas,
            revision_count,
            latest_revision_number,
        ));
    }
    Ok(canvases_out)
}

pub async fn create_canvas(
    db: &Database,
    thread_id: &str,
    title: &str,
    kind: &str,
    content: &str,
    source_user_message_index: Option<usize>,
) -> anyhow::Result<CanvasDetail> {
    let txn = db.connection().begin().await?;
    let id = Uuid::new_v4().to_string();
    let now = now_iso();

    let inserted = canvases::ActiveModel {
        id: Set(id.clone()),
        thread_id: Set(thread_id.to_string()),
        title: Set(title.to_string()),
        kind: Set(kind.to_string()),
        content: Set(content.to_string()),
        created_by_user_message_index: Set(source_user_message_index.map(|value| value as i64)),
        last_updated_by_user_message_index: Set(source_user_message_index.map(|value| value as i64)),
        created_at: Set(now.clone()),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await?;

    create_revision(&txn, &id, 1, content, source_user_message_index).await?;
    txn.commit().await?;

    Ok(to_canvas_detail(inserted, 1, 1))
}

pub async fn update_canvas(
    db: &Database,
    thread_id: &str,
    canvas_id: &str,
    title: Option<&str>,
    content: Option<&str>,
    source_user_message_index: Option<usize>,
) -> anyhow::Result<Option<CanvasDetail>> {
    let Some(existing) = canvases::Entity::find_by_id(canvas_id.to_string())
        .filter(canvases::Column::ThreadId.eq(thread_id.to_string()))
        .one(db.connection())
        .await?
    else {
        return Ok(None);
    };

    let title_changed = title.is_some_and(|next| next != existing.title);
    let content_changed = content.is_some_and(|next| next != existing.content);
    let next_content = content.unwrap_or(&existing.content);

    let txn = db.connection().begin().await?;
    let mut active = existing.clone().into_active_model();
    if let Some(title) = title {
        active.title = Set(title.to_string());
    }
    if let Some(content) = content {
        active.content = Set(content.to_string());
    }
    if source_user_message_index.is_some() {
        active.last_updated_by_user_message_index =
            Set(source_user_message_index.map(|value| value as i64));
    }
    if title_changed || content_changed || source_user_message_index.is_some() {
        active.updated_at = Set(now_iso());
    }
    let updated = active.update(&txn).await?;

    let mut latest_revision_number = canvas_revisions::Entity::find()
        .filter(canvas_revisions::Column::CanvasId.eq(canvas_id.to_string()))
        .order_by_desc(canvas_revisions::Column::RevisionNumber)
        .one(&txn)
        .await?
        .map(|revision| revision.revision_number as usize)
        .unwrap_or(0);

    if content_changed {
        latest_revision_number += 1;
        create_revision(
            &txn,
            canvas_id,
            latest_revision_number,
            next_content,
            source_user_message_index,
        )
        .await?;
    }

    let revision_count = canvas_revisions::Entity::find()
        .filter(canvas_revisions::Column::CanvasId.eq(canvas_id.to_string()))
        .count(&txn)
        .await? as usize;

    txn.commit().await?;

    Ok(Some(to_canvas_detail(
        updated,
        revision_count,
        latest_revision_number,
    )))
}
