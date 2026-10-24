//! Signed in-app updates. Updates are only offered when this build was configured with
//! a public key and an endpoint (see docs/releasing.md); every downloaded installer must
//! carry a valid signature for that key, including the signed version (no downgrades).

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::error::{AppError, AppResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub configured: bool,
    pub current_version: String,
    pub available: Option<String>,
    pub notes: Option<String>,
}

fn configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|c| {
            Some(
                !c.get("pubkey")?.as_str()?.trim().is_empty()
                    && !c.get("endpoints")?.as_array()?.is_empty(),
            )
        })
        .unwrap_or(false)
}

fn err(e: tauri_plugin_updater::Error) -> AppError {
    AppError::Invalid(format!("update failed: {e}"))
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> AppResult<UpdateInfo> {
    let current_version = app.package_info().version.to_string();
    if !configured(&app) {
        return Ok(UpdateInfo {
            configured: false,
            current_version,
            available: None,
            notes: None,
        });
    }
    let update = app.updater().map_err(err)?.check().await.map_err(err)?;
    Ok(UpdateInfo {
        configured: true,
        current_version,
        available: update.as_ref().map(|u| u.version.clone()),
        notes: update.and_then(|u| u.body),
    })
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> AppResult<()> {
    if !configured(&app) {
        return Err(AppError::NotReady(
            "updates are not configured for this build".into(),
        ));
    }
    let Some(update) = app.updater().map_err(err)?.check().await.map_err(err)? else {
        return Err(AppError::Invalid("ClipLock is up to date".into()));
    };
    let mut downloaded = 0usize;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk;
                if let Some(total) = total {
                    let _ = app.emit("update-progress", downloaded as f64 / total as f64);
                }
            },
            || tracing::info!("update downloaded and verified"),
        )
        .await
        .map_err(err)?;
    // Finalize any recording before the installer replaces the app.
    crate::quit(&app);
    Ok(())
}
