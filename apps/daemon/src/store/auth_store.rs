use serde::Serialize;
use uuid::Uuid;

use crate::config::Config;
use crate::db::{now_iso, Database};

const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const DEVICE_AUTH_TTL_MS: i64 = 15 * 60 * 1000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserSession {
    pub session_token: String,
    pub user: AppSessionUser,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionUser {
    pub id: String,
    pub login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthStart {
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    pub expires_at: String,
    pub interval: i64,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum DeviceAuthPoll {
    Pending(DeviceAuthPollPending),
    Complete { status: String, session: UserSession },
    Failed { status: String, error: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthPollPending {
    pub status: String,
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    pub expires_at: String,
    pub interval: i64,
}

pub fn prune(db: &Database) {
    let conn = db.conn.lock().unwrap();
    let now = now_iso();
    let _ = conn.execute("DELETE FROM oauth_states WHERE expires_at < ?1", [&now]);
    let _ = conn.execute("DELETE FROM app_sessions WHERE expires_at < ?1", [&now]);
    let _ = conn.execute(
        "UPDATE device_auth_flows SET status = 'expired', error = 'GitHub device code expired. Start sign-in again.' WHERE status = 'pending' AND expires_at < ?1",
        [&now],
    );
    let cutoff = chrono::Utc::now() - chrono::Duration::milliseconds(DEVICE_AUTH_TTL_MS);
    let _ = conn.execute(
        "DELETE FROM device_auth_flows WHERE created_at < ?1",
        [cutoff.to_rfc3339()],
    );
}

fn find_existing_owner_id(db: &Database, config: &Config) -> String {
    let conn = db.conn.lock().unwrap();
    let result: Result<String, _> = conn.query_row(
        "SELECT github_user_id FROM users ORDER BY updated_at DESC, created_at DESC LIMIT 1",
        [],
        |row| row.get(0),
    );
    result.unwrap_or_else(|_| config.daemon_owner_id.clone())
}

pub fn create_app_session(
    db: &Database,
    config: &Config,
    github_access_token: &str,
    profile: Option<(&str, Option<&str>, Option<&str>)>,
) -> UserSession {
    prune(db);
    let now = now_iso();
    let session_token = Uuid::new_v4().to_string();
    let owner_id = find_existing_owner_id(db, config);
    let (login, name, avatar_url) = profile.unwrap_or((
        &config.daemon_owner_login,
        Some(config.daemon_owner_name.as_str()),
        None,
    ));

    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO users (github_user_id, login, name, avatar_url, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(github_user_id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at",
        rusqlite::params![owner_id, login, name, avatar_url, now, now],
    )
    .unwrap();

    let expires_at = (chrono::Utc::now() + chrono::Duration::milliseconds(SESSION_TTL_MS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    conn.execute(
        "INSERT INTO app_sessions (session_token, github_user_id, github_access_token, auth_mode, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![session_token, owner_id, github_access_token, config.app_auth_mode, now, expires_at],
    )
    .unwrap();

    UserSession {
        session_token,
        user: AppSessionUser {
            id: owner_id,
            login: login.to_string(),
            name: name.map(|s| s.to_string()),
            avatar_url: avatar_url.map(|s| s.to_string()),
        },
    }
}

pub fn create_local_session(db: &Database, config: &Config) -> UserSession {
    create_app_session(db, config, "", None)
}

pub fn destroy_session(db: &Database, token: &str) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute(
        "DELETE FROM app_sessions WHERE session_token = ?1",
        [token],
    );
}

pub fn create_device_auth(
    db: &Database,
    device_code: &str,
    user_code: &str,
    verification_uri: &str,
    verification_uri_complete: Option<&str>,
    expires_in: i64,
    interval: i64,
) -> DeviceAuthStart {
    prune(db);
    let flow_id = Uuid::new_v4().to_string();
    let now = now_iso();
    let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(expires_in))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let next_poll_at = (chrono::Utc::now() + chrono::Duration::seconds(interval))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO device_auth_flows (flow_id, device_code, user_code, verification_uri, verification_uri_complete, expires_at, interval_seconds, next_poll_at, status, session_token, error, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', NULL, NULL, ?9)",
        rusqlite::params![flow_id, device_code, user_code, verification_uri, verification_uri_complete, expires_at, interval, next_poll_at, now],
    )
    .unwrap();

    DeviceAuthStart {
        flow_id,
        user_code: user_code.to_string(),
        verification_uri: verification_uri.to_string(),
        verification_uri_complete: verification_uri_complete.map(|s| s.to_string()),
        expires_at,
        interval,
    }
}

pub struct DeviceAuthRecord {
    pub flow_id: String,
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_at: String,
    pub interval: i64,
    pub next_poll_at: String,
    pub status: String,
    pub session_token: Option<String>,
    pub error: Option<String>,
}

pub fn get_device_auth(db: &Database, flow_id: &str) -> Option<DeviceAuthRecord> {
    prune(db);
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT flow_id, device_code, user_code, verification_uri, verification_uri_complete, expires_at, interval_seconds, next_poll_at, status, session_token, error
         FROM device_auth_flows WHERE flow_id = ?1",
        [flow_id],
        |row| {
            Ok(DeviceAuthRecord {
                flow_id: row.get(0)?,
                device_code: row.get(1)?,
                user_code: row.get(2)?,
                verification_uri: row.get(3)?,
                verification_uri_complete: row.get(4)?,
                expires_at: row.get(5)?,
                interval: row.get(6)?,
                next_poll_at: row.get(7)?,
                status: row.get(8)?,
                session_token: row.get(9)?,
                error: row.get(10)?,
            })
        },
    )
    .ok()
}

pub fn schedule_device_poll(db: &Database, flow_id: &str, interval: Option<i64>) {
    let conn = db.conn.lock().unwrap();
    let actual_interval = interval.unwrap_or(5);
    let next_poll_at = (chrono::Utc::now() + chrono::Duration::seconds(actual_interval))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let _ = conn.execute(
        "UPDATE device_auth_flows SET interval_seconds = ?1, next_poll_at = ?2 WHERE flow_id = ?3 AND status = 'pending'",
        rusqlite::params![actual_interval, next_poll_at, flow_id],
    );
}

pub fn complete_device_auth(db: &Database, flow_id: &str, session_token: &str) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute(
        "UPDATE device_auth_flows SET status = 'complete', session_token = ?1, error = NULL WHERE flow_id = ?2",
        rusqlite::params![session_token, flow_id],
    );
}

pub fn fail_device_auth(db: &Database, flow_id: &str, status: &str, error: &str) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute(
        "UPDATE device_auth_flows SET status = ?1, error = ?2 WHERE flow_id = ?3",
        rusqlite::params![status, error, flow_id],
    );
}

pub fn get_device_auth_poll_payload(
    db: &Database,
    config: &Config,
    flow_id: &str,
) -> Option<DeviceAuthPoll> {
    let record = get_device_auth(db, flow_id)?;

    if record.status == "complete" {
        if let Some(ref token) = record.session_token {
            let session = crate::auth_middleware::get_session(db, config, token)?;
            return Some(DeviceAuthPoll::Complete {
                status: "complete".into(),
                session: UserSession {
                    session_token: session.session_token,
                    user: AppSessionUser {
                        id: session.user_id,
                        login: session.login,
                        name: session.name,
                        avatar_url: session.avatar_url,
                    },
                },
            });
        }
    }

    if record.status == "pending" {
        return Some(DeviceAuthPoll::Pending(DeviceAuthPollPending {
            status: "pending".into(),
            flow_id: record.flow_id,
            user_code: record.user_code,
            verification_uri: record.verification_uri,
            verification_uri_complete: record.verification_uri_complete,
            expires_at: record.expires_at,
            interval: record.interval,
        }));
    }

    Some(DeviceAuthPoll::Failed {
        status: if record.status == "denied" {
            "denied".into()
        } else {
            "expired".into()
        },
        error: record
            .error
            .unwrap_or_else(|| "GitHub device authorization ended unexpectedly.".into()),
    })
}
