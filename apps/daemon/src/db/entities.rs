pub mod app_preferences {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "app_preferences")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub key: String,
        pub value: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod users {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "users")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub github_user_id: String,
        pub login: String,
        pub name: Option<String>,
        pub avatar_url: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {
        #[sea_orm(has_many = "super::app_sessions::Entity")]
        AppSessions,
        #[sea_orm(has_many = "super::projects::Entity")]
        Projects,
        #[sea_orm(has_many = "super::threads::Entity")]
        Threads,
        #[sea_orm(has_many = "super::attachments::Entity")]
        Attachments,
    }

    impl Related<super::app_sessions::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::AppSessions.def()
        }
    }

    impl Related<super::projects::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Projects.def()
        }
    }

    impl Related<super::threads::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Threads.def()
        }
    }

    impl Related<super::attachments::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Attachments.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod app_sessions {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "app_sessions")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub session_token: String,
        pub github_user_id: String,
        pub github_access_token: String,
        pub auth_mode: String,
        pub created_at: String,
        pub expires_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {
        #[sea_orm(
            belongs_to = "super::users::Entity",
            from = "Column::GithubUserId",
            to = "super::users::Column::GithubUserId",
            on_update = "NoAction",
            on_delete = "Cascade"
        )]
        User,
        #[sea_orm(has_many = "super::device_auth_flows::Entity")]
        DeviceAuthFlows,
    }

    impl Related<super::users::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::User.def()
        }
    }

    impl Related<super::device_auth_flows::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::DeviceAuthFlows.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod oauth_states {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "oauth_states")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub state: String,
        pub redirect_uri: Option<String>,
        pub created_at: String,
        pub expires_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod device_auth_flows {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "device_auth_flows")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub flow_id: String,
        pub device_code: String,
        pub user_code: String,
        pub verification_uri: String,
        pub verification_uri_complete: Option<String>,
        pub expires_at: String,
        pub interval_seconds: i64,
        pub next_poll_at: String,
        pub status: String,
        pub session_token: Option<String>,
        pub error: Option<String>,
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {
        #[sea_orm(
            belongs_to = "super::app_sessions::Entity",
            from = "Column::SessionToken",
            to = "super::app_sessions::Column::SessionToken",
            on_update = "NoAction",
            on_delete = "SetNull"
        )]
        AppSession,
    }

    impl Related<super::app_sessions::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::AppSession.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod projects {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "projects")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub github_user_id: String,
        pub name: String,
        pub description: String,
        pub workspace_path: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {
        #[sea_orm(
            belongs_to = "super::users::Entity",
            from = "Column::GithubUserId",
            to = "super::users::Column::GithubUserId",
            on_update = "NoAction",
            on_delete = "Cascade"
        )]
        User,
        #[sea_orm(has_many = "super::threads::Entity")]
        Threads,
    }

    impl Related<super::users::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::User.def()
        }
    }

    impl Related<super::threads::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Threads.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod threads {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "threads")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub github_user_id: String,
        pub project_id: Option<String>,
        pub workspace_path: Option<String>,
        pub title: String,
        pub model: String,
        pub reasoning_effort: Option<String>,
        pub last_message_preview: Option<String>,
        pub copilot_session_id: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {
        #[sea_orm(
            belongs_to = "super::users::Entity",
            from = "Column::GithubUserId",
            to = "super::users::Column::GithubUserId",
            on_update = "NoAction",
            on_delete = "Cascade"
        )]
        User,
        #[sea_orm(
            belongs_to = "super::projects::Entity",
            from = "Column::ProjectId",
            to = "super::projects::Column::Id",
            on_update = "NoAction",
            on_delete = "SetNull"
        )]
        Project,
        #[sea_orm(has_many = "super::attachments::Entity")]
        Attachments,
        #[sea_orm(has_many = "super::message_attachment_sets::Entity")]
        MessageAttachmentSets,
    }

    impl Related<super::users::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::User.def()
        }
    }

    impl Related<super::projects::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Project.def()
        }
    }

    impl Related<super::attachments::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Attachments.def()
        }
    }

    impl Related<super::message_attachment_sets::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::MessageAttachmentSets.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod attachments {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "attachments")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub github_user_id: String,
        pub thread_id: Option<String>,
        pub name: String,
        pub mime_type: String,
        pub size: i64,
        pub kind: String,
        pub file_path: String,
        pub pdf_context_file_path: Option<String>,
        pub pdf_extraction: Option<String>,
        pub pdf_page_count: Option<i64>,
        pub pdf_title: Option<String>,
        pub created_at: String,
        pub updated_at: String,
        pub uploaded_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {
        #[sea_orm(
            belongs_to = "super::users::Entity",
            from = "Column::GithubUserId",
            to = "super::users::Column::GithubUserId",
            on_update = "NoAction",
            on_delete = "Cascade"
        )]
        User,
        #[sea_orm(
            belongs_to = "super::threads::Entity",
            from = "Column::ThreadId",
            to = "super::threads::Column::Id",
            on_update = "NoAction",
            on_delete = "SetNull"
        )]
        Thread,
        #[sea_orm(has_many = "super::message_attachment_set_items::Entity")]
        MessageAttachmentSetItems,
    }

    impl Related<super::users::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::User.def()
        }
    }

    impl Related<super::threads::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Thread.def()
        }
    }

    impl Related<super::message_attachment_set_items::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::MessageAttachmentSetItems.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod message_attachment_sets {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "message_attachment_sets")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub thread_id: String,
        pub user_message_index: i64,
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {
        #[sea_orm(
            belongs_to = "super::threads::Entity",
            from = "Column::ThreadId",
            to = "super::threads::Column::Id",
            on_update = "NoAction",
            on_delete = "Cascade"
        )]
        Thread,
        #[sea_orm(has_many = "super::message_attachment_set_items::Entity")]
        Items,
    }

    impl Related<super::threads::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Thread.def()
        }
    }

    impl Related<super::message_attachment_set_items::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Items.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod message_attachment_set_items {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "message_attachment_set_items")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub message_attachment_set_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub attachment_id: String,
        pub position: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {
        #[sea_orm(
            belongs_to = "super::message_attachment_sets::Entity",
            from = "Column::MessageAttachmentSetId",
            to = "super::message_attachment_sets::Column::Id",
            on_update = "NoAction",
            on_delete = "Cascade"
        )]
        MessageAttachmentSet,
        #[sea_orm(
            belongs_to = "super::attachments::Entity",
            from = "Column::AttachmentId",
            to = "super::attachments::Column::Id",
            on_update = "NoAction",
            on_delete = "Cascade"
        )]
        Attachment,
    }

    impl Related<super::message_attachment_sets::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::MessageAttachmentSet.def()
        }
    }

    impl Related<super::attachments::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Attachment.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
