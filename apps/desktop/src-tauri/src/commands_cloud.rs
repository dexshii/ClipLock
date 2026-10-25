//! Commands for the optional cloud features: account, uploads and sharing.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::cloud::{CloudClip, ServerInfo, Usage, User};
use crate::db::{self, Clip, CloudUpdate};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    server_url: String,
    user: Option<User>,
    /// A session is stored in the credential store but not verified yet.
    has_stored_session: bool,
}

#[tauri::command]
pub async fn cloud_status(app: AppHandle) -> AppResult<CloudStatus> {
    // Reads the OS credential store; keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let server_url = st.settings.read().uploads.server_url.clone();
        CloudStatus {
            server_url,
            user: st.cloud.user(),
            has_stored_session: st.cloud.has_stored_session(),
        }
    })
    .await
    .map_err(|e| AppError::Invalid(format!("background task failed: {e}")))
}

#[tauri::command]
pub async fn cloud_server_info(app: AppHandle) -> AppResult<ServerInfo> {
    app.state::<AppState>().cloud.server_info().await
}

fn signed_in(app: &AppHandle, user: &User) {
    let _ = app.emit("cloud-session", Some(user));
    crate::uploads::resume_interrupted(app);
}

#[tauri::command]
pub async fn cloud_register(
    app: AppHandle,
    email: String,
    password: String,
    display_name: String,
) -> AppResult<User> {
    let user = app
        .state::<AppState>()
        .cloud
        .register(email.trim(), &password, display_name.trim())
        .await?;
    signed_in(&app, &user);
    Ok(user)
}

#[tauri::command]
pub async fn cloud_login(app: AppHandle, email: String, password: String) -> AppResult<User> {
    let user = app
        .state::<AppState>()
        .cloud
        .login(email.trim(), &password)
        .await?;
    signed_in(&app, &user);
    Ok(user)
}

#[tauri::command]
pub async fn cloud_restore(app: AppHandle) -> AppResult<Option<User>> {
    let user = app.state::<AppState>().cloud.restore().await?;
    if let Some(u) = &user {
        signed_in(&app, u);
    }
    Ok(user)
}

#[tauri::command]
pub async fn cloud_logout(app: AppHandle) -> AppResult<()> {
    app.state::<AppState>().cloud.logout().await?;
    let _ = app.emit("cloud-session", None::<User>);
    Ok(())
}

#[tauri::command]
pub async fn cloud_update_profile(app: AppHandle, display_name: String) -> AppResult<User> {
    app.state::<AppState>()
        .cloud
        .update_profile(display_name.trim())
        .await
}

#[tauri::command]
pub async fn cloud_usage(app: AppHandle) -> AppResult<Usage> {
    app.state::<AppState>().cloud.usage().await
}

/// Deletes the server account and all uploaded clips. Local clips are kept and marked
/// as not uploaded.
#[tauri::command]
pub async fn cloud_delete_account(app: AppHandle, password: String) -> AppResult<()> {
    let st = app.state::<AppState>();
    st.cloud.delete_account(&password).await?;
    let ids: Vec<String> = db::list_clips(&st.db.lock(), &Default::default())?
        .into_iter()
        .filter(|c| c.cloud_id.is_some())
        .map(|c| c.id)
        .collect();
    for id in ids {
        let _ = db::delete_upload_session(&st.db.lock(), &id);
        reset_local(&app, &id)?;
    }
    let _ = app.emit("cloud-session", None::<User>);
    Ok(())
}

#[tauri::command]
pub async fn cloud_list_clips(
    app: AppHandle,
    cursor: Option<String>,
) -> AppResult<(Vec<CloudClip>, Option<String>)> {
    app.state::<AppState>()
        .cloud
        .list_clips(cursor.as_deref())
        .await
}

fn validate_visibility(v: &str) -> AppResult<()> {
    if ["private", "unlisted", "public"].contains(&v) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("unknown visibility {v}")))
    }
}

fn reset_local(app: &AppHandle, clip_id: &str) -> AppResult<Clip> {
    let st = app.state::<AppState>();
    let clip = db::update_cloud(
        &st.db.lock(),
        clip_id,
        &CloudUpdate {
            status: Some("LOCAL".into()),
            progress: Some(None),
            error: Some(None),
            cloud_id: Some(None),
            share_url: Some(None),
            media_url: Some(None),
            visibility: Some(None),
            sha256: None,
        },
    )?;
    let _ = app.emit("clip-updated", &clip);
    Ok(clip)
}

/// Starts (or retries) uploading a clip. Only ever triggered by the user.
#[tauri::command]
pub async fn upload_clip(
    app: AppHandle,
    id: String,
    visibility: Option<String>,
) -> AppResult<Clip> {
    let st = app.state::<AppState>();
    st.cloud.server()?;
    if st.cloud.user().is_none() && st.cloud.restore().await?.is_none() {
        return Err(AppError::Unauthorized);
    }
    if let Some(v) = &visibility {
        validate_visibility(v)?;
    }
    let clip = db::get_clip(&st.db.lock(), &id)?;
    if matches!(clip.status.as_str(), "READY" | "PROCESSING") {
        return Ok(clip);
    }
    let clip = db::update_cloud(
        &st.db.lock(),
        &id,
        &CloudUpdate {
            status: Some("QUEUED".into()),
            error: Some(None),
            visibility: visibility.map(Some),
            ..Default::default()
        },
    )?;
    let _ = app.emit("clip-updated", &clip);
    st.uploads.enqueue(&id);
    Ok(clip)
}

#[tauri::command]
pub async fn cancel_upload(app: AppHandle, id: String) -> AppResult<()> {
    let st = app.state::<AppState>();
    if st.uploads.request_cancel(&id) {
        return Ok(());
    }
    // Not running right now (queued behind another upload, or failed): clean up directly.
    let clip = db::get_clip(&st.db.lock(), &id)?;
    let session = db::get_upload_session(&st.db.lock(), &id)?;
    if let Some(session) = session {
        if let Err(e) = st.cloud.cancel_upload(&session.cloud_id).await {
            tracing::warn!("server-side cancel failed: {e}");
        }
        db::delete_upload_session(&st.db.lock(), &id)?;
    }
    if matches!(clip.status.as_str(), "QUEUED" | "UPLOADING" | "FAILED") {
        reset_local(&app, &id)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_cloud_visibility(
    app: AppHandle,
    id: String,
    visibility: String,
) -> AppResult<Clip> {
    validate_visibility(&visibility)?;
    let st = app.state::<AppState>();
    let clip = db::get_clip(&st.db.lock(), &id)?;
    let cloud_id = clip
        .cloud_id
        .ok_or_else(|| AppError::Invalid("this clip has not been uploaded".into()))?;
    let cloud = st
        .cloud
        .update_clip(&cloud_id, serde_json::json!({ "visibility": visibility }))
        .await?;
    let clip = db::update_cloud(
        &st.db.lock(),
        &id,
        &CloudUpdate {
            visibility: Some(Some(cloud.visibility)),
            media_url: Some(cloud.media_url),
            share_url: Some(Some(cloud.share_url)),
            ..Default::default()
        },
    )?;
    let _ = app.emit("clip-updated", &clip);
    Ok(clip)
}

/// Removes the uploaded copy (and its share link). The local file is untouched.
#[tauri::command]
pub async fn delete_cloud_copy(app: AppHandle, id: String) -> AppResult<Clip> {
    let st = app.state::<AppState>();
    let clip = db::get_clip(&st.db.lock(), &id)?;
    if let Some(cloud_id) = &clip.cloud_id {
        match st.cloud.delete_clip(cloud_id).await {
            Ok(()) | Err(AppError::Api { status: 404, .. }) => {}
            Err(e) => return Err(e),
        }
    }
    reset_local(&app, &id)
}
