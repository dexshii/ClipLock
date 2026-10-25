//! Tauri commands invoked by the UI. Anything that may block (disk, FFmpeg, encoder
//! start/stop) runs on the blocking thread pool so the UI thread stays responsive.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

use crate::db::{self, Clip, ClipKind, ClipPatch, ClipQuery, LibraryStats};
use crate::error::{AppError, AppResult};
use crate::games::GameDb;
use crate::recorder::{self, RecorderState};
use crate::settings::AppSettings;
use crate::state::AppState;
use crate::util::{is_within, sanitize_file_name, unique_path};

/// Runs `f` on the blocking pool. Synchronous commands run on the main (UI) thread,
/// so anything that can wait on a lock (engine, database) or on I/O must go through here
/// or the window stops responding.
async fn blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Invalid(format!("background task failed: {e}")))?
}

// ------------------------------------------------------------------ app

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    os: String,
    arch: String,
    config_dir: PathBuf,
    data_dir: PathBuf,
    log_dir: PathBuf,
    default_clips_dir: PathBuf,
    ffmpeg_version: Option<String>,
    debug: bool,
}

#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppInfo {
    let st = app.state::<AppState>();
    AppInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        config_dir: st.paths.config_dir.clone(),
        data_dir: st.paths.data_dir.clone(),
        log_dir: st.paths.log_dir.clone(),
        default_clips_dir: st.paths.default_clips_dir.clone(),
        ffmpeg_version: st.recorder.capabilities().map(|c| c.ffmpeg_version),
        debug: cfg!(debug_assertions),
    }
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> AppResult<()> {
    let dir = app.state::<AppState>().paths.log_dir.clone();
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Invalid(e.to_string()))
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    crate::quit(&app);
}

// ------------------------------------------------------------------ settings

#[tauri::command]
pub fn get_settings(app: AppHandle) -> AppSettings {
    app.state::<AppState>().settings.read().clone()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    settings: AppSettings,
    /// Hotkeys that could not be registered (taken by another program).
    hotkey_failures: Vec<String>,
}

#[tauri::command]
pub async fn update_settings(app: AppHandle, settings: AppSettings) -> AppResult<SettingsUpdate> {
    blocking(move || {
        settings.validate()?;
        let st = app.state::<AppState>();
        let old = st.settings.read().clone();
        if old.storage.clips_dir != settings.storage.clips_dir {
            let dir = settings.clips_dir(&st.paths.default_clips_dir);
            std::fs::create_dir_all(&dir)?;
            app.asset_protocol_scope().allow_directory(&dir, true)?;
        }
        *st.settings.write() = settings.clone();
        if let Err(e) = recorder::apply_settings(&app, &old, &settings) {
            *st.settings.write() = old;
            return Err(e);
        }
        settings.save(&st.paths.config_dir)?;

        let hotkey_failures = if old.hotkeys != settings.hotkeys {
            crate::hotkeys::apply(&app, &settings.hotkeys)
        } else {
            Vec::new()
        };
        if old.general.launch_on_startup != settings.general.launch_on_startup {
            let al = app.autolaunch();
            let r = if settings.general.launch_on_startup {
                al.enable()
            } else {
                al.disable()
            };
            if let Err(e) = r {
                tracing::warn!("autostart update failed: {e}");
            }
        }
        if old.uploads.server_url != settings.uploads.server_url {
            st.cloud.set_server(&settings.uploads.server_url);
            let _ = app.emit("cloud-session", None::<crate::cloud::User>);
        }
        if old.general.custom_games != settings.general.custom_games {
            *st.games.db.write() = GameDb::load(
                &st.paths.resource("games.json"),
                &settings.general.custom_games,
            );
        }
        crate::tray::refresh(&app);
        let _ = app.emit("settings-changed", &settings);
        Ok(SettingsUpdate {
            settings,
            hotkey_failures,
        })
    })
    .await
}

// ------------------------------------------------------------------ recorder

#[tauri::command]
pub async fn get_recorder_state(app: AppHandle) -> AppResult<RecorderState> {
    blocking(move || Ok(app.state::<AppState>().recorder.state(&app))).await
}

#[tauri::command]
pub async fn start_replay(app: AppHandle) -> AppResult<()> {
    blocking(move || recorder::start_replay(&app)).await
}

#[tauri::command]
pub async fn stop_replay(app: AppHandle) -> AppResult<()> {
    blocking(move || recorder::stop_replay(&app)).await
}

#[tauri::command]
pub async fn save_replay(app: AppHandle, seconds: Option<u32>) -> AppResult<Clip> {
    blocking(move || recorder::save_replay(&app, seconds)).await
}

#[tauri::command]
pub async fn start_recording(app: AppHandle) -> AppResult<()> {
    blocking(move || recorder::start_recording(&app)).await
}

#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> AppResult<Clip> {
    blocking(move || recorder::stop_recording(&app)).await
}

#[tauri::command]
pub async fn toggle_pause(app: AppHandle) -> AppResult<()> {
    blocking(move || recorder::toggle_pause(&app)).await
}

#[tauri::command]
pub async fn set_mic_muted(app: AppHandle, muted: bool) -> AppResult<()> {
    blocking(move || {
        app.state::<AppState>()
            .recorder
            .engine()?
            .set_mic_muted(muted);
        recorder::emit_state(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn reprobe_hardware(app: AppHandle) -> AppResult<()> {
    blocking(move || {
        let st = app.state::<AppState>();
        if let Ok(engine) = st.recorder.engine() {
            if engine.status().recording.is_some() {
                return Err(AppError::Invalid(
                    "stop the recording before re-detecting hardware".into(),
                ));
            }
        }
        recorder::initialize(app.clone(), true);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn list_audio_devices() -> AppResult<Vec<cliplock_capture::audio::AudioDevice>> {
    blocking(|| Ok(cliplock_capture::audio::list_devices())).await
}

// ------------------------------------------------------------------ games

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameOption {
    id: String,
    name: String,
}

#[tauri::command]
pub fn list_games(app: AppHandle) -> Vec<GameOption> {
    let st = app.state::<AppState>();
    let db = st.games.db.read();
    let mut games: Vec<GameOption> = db
        .entries()
        .iter()
        .map(|g| GameOption {
            id: g.id.clone(),
            name: g.name.clone(),
        })
        .collect();
    games.sort_by_key(|g| g.name.to_lowercase());
    games
}

#[tauri::command]
pub async fn set_manual_game(
    app: AppHandle,
    name: Option<String>,
    hwnd: Option<u64>,
) -> AppResult<()> {
    blocking(move || {
        let st = app.state::<AppState>();
        let target = name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .map(|name| crate::games::ManualTarget { name, hwnd });
        let changed = *st.games.manual.read() != target;
        *st.games.manual.write() = target;
        if changed {
            // In game-window mode, capture switches to the picked window.
            recorder::on_game_window_changed(&app);
        }
        recorder::emit_state(&app);
        Ok(())
    })
    .await
}

/// Running games and open application windows, for choosing what to capture.
#[tauri::command]
pub async fn list_running_apps(app: AppHandle) -> AppResult<Vec<crate::games::RunningApp>> {
    blocking(move || {
        let st = app.state::<AppState>();
        let mut system = sysinfo::System::new();
        let processes = crate::games::running_processes(&mut system);
        let windows = crate::games::open_windows();
        let db = st.games.db.read();
        Ok(crate::games::running_apps(&db, &processes, &windows))
    })
    .await
}

// ------------------------------------------------------------------ library

#[tauri::command]
pub async fn list_clips(app: AppHandle, query: Option<ClipQuery>) -> AppResult<Vec<Clip>> {
    blocking(move || {
        db::list_clips(
            &app.state::<AppState>().db.lock(),
            &query.unwrap_or_default(),
        )
    })
    .await
}

#[tauri::command]
pub async fn list_clip_games(app: AppHandle) -> AppResult<Vec<String>> {
    blocking(move || db::game_names(&app.state::<AppState>().db.lock())).await
}

#[tauri::command]
pub async fn get_clip(app: AppHandle, id: String) -> AppResult<Clip> {
    blocking(move || db::get_clip(&app.state::<AppState>().db.lock(), &id)).await
}

#[tauri::command]
pub async fn update_clip(app: AppHandle, id: String, patch: ClipPatch) -> AppResult<Clip> {
    blocking(move || {
        let clip = db::update_clip(&app.state::<AppState>().db.lock(), &id, &patch)?;
        let _ = app.emit("clip-updated", &clip);
        Ok(clip)
    })
    .await
}

#[tauri::command]
pub async fn delete_clip(app: AppHandle, id: String, delete_file: bool) -> AppResult<bool> {
    blocking(move || {
        let st = app.state::<AppState>();
        let clip = db::get_clip(&st.db.lock(), &id)?;
        let clips_dir = st.settings.read().clips_dir(&st.paths.default_clips_dir);
        let mut file_removed = false;
        if delete_file && clip.file_path.exists() {
            // Only touch files inside the clip folder; anything else is just unlisted.
            if is_within(&clips_dir, &clip.file_path) {
                if let Err(e) = trash::delete(&clip.file_path) {
                    tracing::warn!("recycle bin unavailable ({e}); deleting permanently");
                    std::fs::remove_file(&clip.file_path)?;
                }
                file_removed = true;
            } else {
                tracing::warn!(
                    "not deleting {} (outside the clip folder)",
                    clip.file_path.display()
                );
            }
        }
        if let Some(thumb) = &clip.thumbnail_path {
            if is_within(&st.paths.thumbnails_dir, thumb) {
                let _ = std::fs::remove_file(thumb);
            }
        }
        db::delete_clip(&st.db.lock(), &id)?;
        let _ = app.emit("clip-deleted", &id);
        Ok(file_removed)
    })
    .await
}

#[tauri::command]
pub async fn reveal_clip(app: AppHandle, id: String) -> AppResult<()> {
    blocking(move || {
        let clip = db::get_clip(&app.state::<AppState>().db.lock(), &id)?;
        if !clip.file_path.exists() {
            return Err(AppError::NotFound("the video file no longer exists".into()));
        }
        app.opener()
            .reveal_item_in_dir(&clip.file_path)
            .map_err(|e| AppError::Invalid(e.to_string()))
    })
    .await
}

#[tauri::command]
pub async fn export_clip(app: AppHandle, id: String, destination: PathBuf) -> AppResult<()> {
    blocking(move || {
        let clip = db::get_clip(&app.state::<AppState>().db.lock(), &id)?;
        if destination == clip.file_path {
            return Err(AppError::Invalid("choose a different location".into()));
        }
        if destination
            .extension()
            .is_none_or(|e| !e.eq_ignore_ascii_case("mp4"))
        {
            return Err(AppError::Invalid("export as an .mp4 file".into()));
        }
        std::fs::copy(&clip.file_path, &destination)?;
        Ok(())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    library: LibraryStats,
    clips_dir: PathBuf,
    buffer_dir: PathBuf,
    buffer_bytes: u64,
    free_bytes: Option<u64>,
    warning_bytes: u64,
}

fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    rd.filter_map(|e| e.ok())
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

fn free_space(path: &std::path::Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let path = path.canonicalize().ok()?;
    disks
        .list()
        .iter()
        .filter(|d| path.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

#[tauri::command]
pub async fn storage_info(app: AppHandle) -> AppResult<StorageInfo> {
    blocking(move || {
        let st = app.state::<AppState>();
        let settings = st.settings.read().clone();
        let clips_dir = settings.clips_dir(&st.paths.default_clips_dir);
        let buffer_dir = settings.buffer_dir(&st.paths.default_buffer_dir);
        let _ = std::fs::create_dir_all(&clips_dir);
        let library = db::stats(&st.db.lock())?;
        Ok(StorageInfo {
            library,
            buffer_bytes: dir_size(&buffer_dir),
            free_bytes: free_space(&clips_dir),
            warning_bytes: settings.storage.library_warning_gb as u64 * 1024 * 1024 * 1024,
            clips_dir,
            buffer_dir,
        })
    })
    .await
}

#[tauri::command]
pub async fn regenerate_thumbnail(
    app: AppHandle,
    id: String,
    at_secs: Option<f64>,
) -> AppResult<Clip> {
    blocking(move || {
        let st = app.state::<AppState>();
        let clip = db::get_clip(&st.db.lock(), &id)?;
        let ffmpeg = st.recorder.ffmpeg()?;
        let thumb = st.paths.thumbnails_dir.join(format!("{}.jpg", clip.id));
        let at = at_secs.unwrap_or((clip.duration_ms as f64 / 1000.0 * 0.3).min(5.0));
        cliplock_capture::media::thumbnail(&ffmpeg, &clip.file_path, &thumb, at, 480)?;
        db::update_media(&st.db.lock(), &id, Some(&thumb), clip.size_bytes)?;
        let clip = db::get_clip(&st.db.lock(), &id)?;
        let _ = app.emit("clip-updated", &clip);
        Ok(clip)
    })
    .await
}

// ------------------------------------------------------------------ editor

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRequest {
    trim_start_ms: i64,
    trim_end_ms: i64,
    speed: f64,
    mute: bool,
    volume: f64,
    lossless: bool,
    title: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    clip_id: String,
    progress: f64,
}

/// Exports an edited copy next to the original (which is never modified) and adds it
/// to the library.
#[tauri::command]
pub async fn export_edit(app: AppHandle, id: String, request: EditRequest) -> AppResult<Clip> {
    blocking(move || {
        let st = app.state::<AppState>();
        let source = db::get_clip(&st.db.lock(), &id)?;
        let ffmpeg = st.recorder.ffmpeg()?;
        let title = request
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{} (edit)", source.title));
        let dir = source
            .file_path
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| AppError::Invalid("bad clip path".into()))?;
        let output = unique_path(&dir, &sanitize_file_name(&title, "Edited clip"), "mp4");
        let spec = cliplock_capture::EditSpec {
            input: source.file_path.clone(),
            output,
            trim_start_secs: request.trim_start_ms as f64 / 1000.0,
            trim_end_secs: request.trim_end_ms as f64 / 1000.0,
            speed: request.speed,
            mute: request.mute,
            volume: request.volume,
            lossless: request.lossless,
        };
        // Edits are for sharing, so always produce H.264 (fastest available encoder first).
        let encoders: Vec<_> = st
            .recorder
            .capabilities()
            .map(|c| {
                c.encoders
                    .into_iter()
                    .filter(|e| e.codec == cliplock_capture::Codec::H264)
                    .collect()
            })
            .unwrap_or_default();
        let clip_id = source.id.clone();
        let mut last_emit = 0.0;
        let info = cliplock_capture::media::export_edit(&ffmpeg, &spec, &encoders, |p| {
            if p - last_emit >= 0.01 || p >= 1.0 {
                last_emit = p;
                let _ = app.emit(
                    "export-progress",
                    ExportProgress {
                        clip_id: clip_id.clone(),
                        progress: p,
                    },
                );
            }
        })?;
        let saved = cliplock_capture::SavedClip {
            path: spec.output.clone(),
            info,
        };
        recorder::add_to_library(&app, &saved, ClipKind::Edit, &title, Some(source.id))
    })
    .await
}
