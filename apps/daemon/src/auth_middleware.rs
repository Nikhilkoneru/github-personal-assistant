use axum::http::HeaderMap;

use crate::config::Config;
use crate::db::Database;

pub struct AuthSession {
    pub session_token: String,
    pub user_id: String,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub github_access_token: String,
}

pub fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            return Some(token.to_string());
        }
    }
    if let Some(token) = headers.get("x-session-token").and_then(|v| v.to_str().ok()) {
        return Some(token.to_string());
    }
    None
}

pub fn check_service_access(headers: &HeaderMap, config: &Config) -> bool {
    let Some(ref required) = config.service_access_token else {
        return true;
    };
    let provided = headers
        .get("x-service-access-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    provided == required
}

pub fn get_session(db: &Database, config: &Config, token: &str) -> Option<AuthSession> {
    let conn = db.conn.lock().unwrap();
    let now = crate::db::now_iso();
    let mut stmt = conn
        .prepare(
            "SELECT s.session_token, s.github_access_token, u.github_user_id, u.login, u.name, u.avatar_url
             FROM app_sessions s
             JOIN users u ON u.github_user_id = s.github_user_id
             WHERE s.session_token = ?1 AND s.expires_at >= ?2 AND s.auth_mode = ?3",
        )
        .ok()?;
    stmt.query_row(
        rusqlite::params![token, now, config.app_auth_mode],
        |row| {
            Ok(AuthSession {
                session_token: row.get(0)?,
                github_access_token: row.get(1)?,
                user_id: row.get(2)?,
                login: row.get(3)?,
                name: row.get(4)?,
                avatar_url: row.get(5)?,
            })
        },
    )
    .ok()
}

pub fn require_session(
    headers: &HeaderMap,
    db: &Database,
    config: &Config,
) -> Result<AuthSession, crate::error::AppError> {
    if !check_service_access(headers, config) {
        return Err(crate::error::AppError::Unauthorized(
            "Missing or invalid service access token.".into(),
        ));
    }
    let token = extract_bearer_token(headers).ok_or_else(|| {
        if config.app_auth_mode == "local" {
            crate::error::AppError::Unauthorized(
                "Your local daemon session is missing. Start a new local session and try again."
                    .into(),
            )
        } else {
            crate::error::AppError::Unauthorized(
                "You must sign in to use this product.".into(),
            )
        }
    })?;
    get_session(db, config, &token).ok_or_else(|| {
        crate::error::AppError::Unauthorized("Your session expired. Please sign in again.".into())
    })
}
