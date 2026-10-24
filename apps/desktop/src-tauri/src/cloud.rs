//! Client for a ClipLock server (official or self-hosted). Cloud features are optional:
//! everything else in the app works without an account or a server.
//!
//! The refresh token is kept in the OS credential store (Windows Credential Manager),
//! never in the settings file; the short-lived access token lives only in memory.

use std::time::{Duration, Instant};

use parking_lot::Mutex;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{AppError, AppResult};

const KEYRING_SERVICE: &str = "ClipLock";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    user: User,
    access_token: String,
    refresh_token: String,
    access_token_expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub public_base_url: String,
    pub registration_open: bool,
    pub max_upload_bytes: u64,
    pub max_clip_duration_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudClip {
    pub id: String,
    pub title: String,
    pub game_name: Option<String>,
    pub status: String,
    pub visibility: String,
    pub allow_download: bool,
    pub duration_ms: i64,
    pub width: i64,
    pub height: i64,
    pub size_bytes: i64,
    pub created_at: String,
    pub error: Option<String>,
    pub share_url: String,
    pub media_url: Option<String>,
    pub thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSessionInfo {
    pub part_size: i64,
    pub part_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateClipResponse {
    pub clip: CloudClip,
    pub upload: Option<UploadSessionInfo>,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresignedPart {
    pub part_number: i64,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedPart {
    pub part_number: i64,
    pub etag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub clip_count: i64,
    pub used_bytes: i64,
    pub quota_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewClip<'a> {
    pub title: &'a str,
    pub game_name: Option<&'a str>,
    pub duration_ms: i64,
    pub width: i64,
    pub height: i64,
    pub size_bytes: i64,
    pub sha256: &'a str,
    pub visibility: &'a str,
    pub allow_download: bool,
    pub recorded_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    error: String,
    message: String,
}

struct Tokens {
    access: String,
    access_expires: Instant,
}

/// Session state for the configured server.
#[derive(Default)]
pub struct Cloud {
    http: reqwest::Client,
    state: Mutex<CloudState>,
    /// Serializes token refreshes so concurrent requests do not race (and trigger
    /// refresh-token reuse detection on the server).
    refresh_lock: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct CloudState {
    server: String,
    tokens: Option<Tokens>,
    user: Option<User>,
}

fn keyring_entry(server: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("refresh-token:{server}")).ok()
}

fn stored_refresh_token(server: &str) -> Option<String> {
    keyring_entry(server)?.get_password().ok()
}

fn store_refresh_token(server: &str, token: Option<&str>) {
    let Some(entry) = keyring_entry(server) else {
        return;
    };
    let result = match token {
        Some(t) => entry.set_password(t),
        None => entry.delete_credential(),
    };
    if let Err(e) = result {
        if !matches!(e, keyring::Error::NoEntry) {
            tracing::warn!("credential store unavailable: {e}");
        }
    }
}

impl Cloud {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("ClipLock/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("HTTP client");
        Self {
            http,
            ..Default::default()
        }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// Switches to `server` (empty = local-only). Drops the in-memory session if the
    /// server changed.
    pub fn set_server(&self, server: &str) {
        let mut s = self.state.lock();
        if s.server != server {
            s.server = server.trim_end_matches('/').to_string();
            s.tokens = None;
            s.user = None;
        }
    }

    pub fn server(&self) -> AppResult<String> {
        let server = self.state.lock().server.clone();
        if server.is_empty() {
            return Err(AppError::NotReady(
                "No server configured. Add one in Settings → Uploads.".into(),
            ));
        }
        Ok(server)
    }

    pub fn user(&self) -> Option<User> {
        self.state.lock().user.clone()
    }

    pub fn has_stored_session(&self) -> bool {
        self.server()
            .ok()
            .and_then(|s| stored_refresh_token(&s))
            .is_some()
    }

    fn accept_session(&self, server: &str, session: SessionResponse) -> User {
        let ttl = chrono::DateTime::parse_from_rfc3339(&session.access_token_expires_at)
            .map(|exp| (exp.timestamp() - chrono::Utc::now().timestamp()).max(0) as u64)
            .unwrap_or(60);
        store_refresh_token(server, Some(&session.refresh_token));
        let mut s = self.state.lock();
        s.tokens = Some(Tokens {
            access: session.access_token,
            access_expires: Instant::now() + Duration::from_secs(ttl),
        });
        s.user = Some(session.user.clone());
        session.user
    }

    async fn send<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
        token: Option<&str>,
    ) -> AppResult<(StatusCode, Option<T>)> {
        let url = format!("{}{path}", self.server()?);
        let mut req = self
            .http
            .request(method, url)
            .timeout(Duration::from_secs(60));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await?;
        let status = res.status();
        if status == StatusCode::NO_CONTENT {
            return Ok((status, None));
        }
        if status.is_success() {
            return Ok((status, Some(res.json::<T>().await?)));
        }
        let text = res.text().await.unwrap_or_default();
        if status == StatusCode::UNAUTHORIZED && token.is_some() {
            return Ok((status, None));
        }
        Err(match serde_json::from_str::<ApiErrorBody>(&text) {
            Ok(e) => AppError::Api {
                status: status.as_u16(),
                code: e.error,
                message: e.message,
            },
            Err(_) => AppError::Api {
                status: status.as_u16(),
                code: "http".into(),
                message: format!("Server responded with {status}"),
            },
        })
    }

    async fn refresh(&self) -> AppResult<()> {
        let _guard = self.refresh_lock.lock().await;
        let server = self.server()?;
        if self
            .state
            .lock()
            .tokens
            .as_ref()
            .is_some_and(|t| t.access_expires > Instant::now() + Duration::from_secs(30))
        {
            return Ok(()); // another request refreshed while we waited
        }
        let Some(refresh) = stored_refresh_token(&server) else {
            self.state.lock().user = None;
            return Err(AppError::Unauthorized);
        };
        match self
            .send::<SessionResponse>(
                Method::POST,
                "/v1/auth/refresh",
                Some(json!({ "refreshToken": refresh })),
                None,
            )
            .await
        {
            Ok((_, Some(session))) => {
                self.accept_session(&server, session);
                Ok(())
            }
            Ok(_) => Err(AppError::Unauthorized),
            Err(AppError::Api { status: 401, .. }) => {
                store_refresh_token(&server, None);
                let mut s = self.state.lock();
                s.tokens = None;
                s.user = None;
                Err(AppError::Unauthorized)
            }
            Err(e) => Err(e),
        }
    }

    async fn access_token(&self) -> AppResult<String> {
        let valid = {
            let s = self.state.lock();
            s.tokens
                .as_ref()
                .filter(|t| t.access_expires > Instant::now() + Duration::from_secs(30))
                .map(|t| t.access.clone())
        };
        match valid {
            Some(t) => Ok(t),
            None => {
                self.refresh().await?;
                self.state
                    .lock()
                    .tokens
                    .as_ref()
                    .map(|t| t.access.clone())
                    .ok_or(AppError::Unauthorized)
            }
        }
    }

    /// Authenticated request; refreshes the session once on 401.
    pub async fn authed<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> AppResult<Option<T>> {
        for attempt in 0..2 {
            let token = self.access_token().await?;
            let (status, value) = self
                .send::<T>(method.clone(), path, body.clone(), Some(&token))
                .await?;
            if status == StatusCode::UNAUTHORIZED {
                self.state.lock().tokens = None;
                if attempt == 0 {
                    continue;
                }
                return Err(AppError::Unauthorized);
            }
            return Ok(value);
        }
        Err(AppError::Unauthorized)
    }

    async fn authed_some<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> AppResult<T> {
        self.authed(method, path, body)
            .await?
            .ok_or_else(|| AppError::Invalid("empty response from server".into()))
    }

    // ------------------------------------------------------------- account

    pub async fn server_info(&self) -> AppResult<ServerInfo> {
        let (_, info) = self
            .send::<ServerInfo>(Method::GET, "/v1/server-info", None, None)
            .await?;
        let info = info.ok_or_else(|| AppError::Invalid("not a ClipLock server".into()))?;
        if info.name != "cliplock" {
            return Err(AppError::Invalid("not a ClipLock server".into()));
        }
        Ok(info)
    }

    pub async fn register(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> AppResult<User> {
        let server = self.server()?;
        let body = json!({ "email": email, "password": password, "displayName": display_name });
        let (_, session) = self
            .send::<SessionResponse>(Method::POST, "/v1/auth/register", Some(body), None)
            .await?;
        Ok(self.accept_session(&server, session.ok_or(AppError::Unauthorized)?))
    }

    pub async fn login(&self, email: &str, password: &str) -> AppResult<User> {
        let server = self.server()?;
        let body = json!({ "email": email, "password": password });
        let (_, session) = self
            .send::<SessionResponse>(Method::POST, "/v1/auth/login", Some(body), None)
            .await?;
        Ok(self.accept_session(&server, session.ok_or(AppError::Unauthorized)?))
    }

    /// Restores the session from the credential store, if any.
    pub async fn restore(&self) -> AppResult<Option<User>> {
        if !self.has_stored_session() {
            return Ok(None);
        }
        let user: User = self.authed_some(Method::GET, "/v1/me", None).await?;
        self.state.lock().user = Some(user.clone());
        Ok(Some(user))
    }

    pub async fn logout(&self) -> AppResult<()> {
        let server = self.server()?;
        let refresh = stored_refresh_token(&server);
        if self.state.lock().tokens.is_some() || refresh.is_some() {
            let body = json!({ "refreshToken": refresh });
            if let Err(e) = self
                .authed::<serde_json::Value>(Method::POST, "/v1/auth/logout", Some(body))
                .await
            {
                tracing::warn!("server logout failed (signing out locally anyway): {e}");
            }
        }
        store_refresh_token(&server, None);
        let mut s = self.state.lock();
        s.tokens = None;
        s.user = None;
        Ok(())
    }

    pub async fn update_profile(&self, display_name: &str) -> AppResult<User> {
        let user: User = self
            .authed_some(
                Method::PATCH,
                "/v1/me",
                Some(json!({ "displayName": display_name })),
            )
            .await?;
        self.state.lock().user = Some(user.clone());
        Ok(user)
    }

    pub async fn usage(&self) -> AppResult<Usage> {
        self.authed_some(Method::GET, "/v1/me/usage", None).await
    }

    pub async fn delete_account(&self, password: &str) -> AppResult<()> {
        let server = self.server()?;
        self.authed::<serde_json::Value>(
            Method::DELETE,
            "/v1/me",
            Some(json!({ "password": password })),
        )
        .await?;
        store_refresh_token(&server, None);
        let mut s = self.state.lock();
        s.tokens = None;
        s.user = None;
        Ok(())
    }

    // ------------------------------------------------------------- clips

    pub async fn create_clip(&self, clip: &NewClip<'_>) -> AppResult<CreateClipResponse> {
        self.authed_some(Method::POST, "/v1/clips", Some(serde_json::to_value(clip)?))
            .await
    }

    pub async fn part_urls(&self, cloud_id: &str, parts: &[i64]) -> AppResult<Vec<PresignedPart>> {
        #[derive(Deserialize)]
        struct R {
            parts: Vec<PresignedPart>,
        }
        let r: R = self
            .authed_some(
                Method::POST,
                &format!("/v1/clips/{cloud_id}/upload/parts"),
                Some(json!({ "partNumbers": parts })),
            )
            .await?;
        Ok(r.parts)
    }

    pub async fn uploaded_parts(&self, cloud_id: &str) -> AppResult<Vec<UploadedPart>> {
        #[derive(Deserialize)]
        struct R {
            parts: Vec<UploadedPart>,
        }
        let r: R = self
            .authed_some(
                Method::GET,
                &format!("/v1/clips/{cloud_id}/upload/parts"),
                None,
            )
            .await?;
        Ok(r.parts)
    }

    pub async fn complete_upload(
        &self,
        cloud_id: &str,
        parts: &[(i64, String)],
    ) -> AppResult<CloudClip> {
        let parts: Vec<_> = parts
            .iter()
            .map(|(n, e)| json!({ "partNumber": n, "etag": e }))
            .collect();
        self.authed_some(
            Method::POST,
            &format!("/v1/clips/{cloud_id}/upload/complete"),
            Some(json!({ "parts": parts })),
        )
        .await
    }

    pub async fn cancel_upload(&self, cloud_id: &str) -> AppResult<()> {
        self.authed::<serde_json::Value>(
            Method::DELETE,
            &format!("/v1/clips/{cloud_id}/upload"),
            None,
        )
        .await
        .map(|_| ())
    }

    pub async fn get_clip(&self, cloud_id: &str) -> AppResult<CloudClip> {
        self.authed_some(Method::GET, &format!("/v1/clips/{cloud_id}"), None)
            .await
    }

    pub async fn update_clip(
        &self,
        cloud_id: &str,
        patch: serde_json::Value,
    ) -> AppResult<CloudClip> {
        self.authed_some(Method::PATCH, &format!("/v1/clips/{cloud_id}"), Some(patch))
            .await
    }

    pub async fn delete_clip(&self, cloud_id: &str) -> AppResult<()> {
        self.authed::<serde_json::Value>(Method::DELETE, &format!("/v1/clips/{cloud_id}"), None)
            .await
            .map(|_| ())
    }

    pub async fn list_clips(
        &self,
        cursor: Option<&str>,
    ) -> AppResult<(Vec<CloudClip>, Option<String>)> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct R {
            clips: Vec<CloudClip>,
            next_cursor: Option<String>,
        }
        let path = match cursor {
            Some(c) => format!(
                "/v1/clips?limit=50&cursor={}",
                url::form_urlencoded::byte_serialize(c.as_bytes()).collect::<String>()
            ),
            None => "/v1/clips?limit=50".to_string(),
        };
        let r: R = self.authed_some(Method::GET, &path, None).await?;
        Ok((r.clips, r.next_cursor))
    }
}
