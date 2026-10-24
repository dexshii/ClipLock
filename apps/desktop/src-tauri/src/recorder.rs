//! Glue between the UI/hotkeys/tray and the capture engine: initialization, file
//! naming, adding saved clips to the library, and user feedback.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::Local;
use cliplock_capture::{
    Capabilities, CaptureEngine, EngineEvent, EngineStatus, Ffmpeg, SavedClip, VideoSource,
};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db::{self, Clip, ClipKind, NewClip};
use crate::error::{AppError, AppResult};
use crate::games::DetectedGame;
use crate::settings::AppSettings;
use crate::sound::{self, Cue};
use crate::state::AppState;
use crate::util::{sanitize_file_name, unique_path};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum InitState {
    Initializing,
    Ready,
    Failed { message: String },
}

#[derive(Default)]
pub struct Recorder {
    engine: RwLock<Option<Arc<CaptureEngine>>>,
    init: RwLock<Option<InitState>>,
    capabilities: RwLock<Option<Capabilities>>,
    ffmpeg: RwLock<Option<Ffmpeg>>,
    saving: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderState {
    pub capture_source: Option<VideoSource>,
    pub init: InitState,
    pub capabilities: Option<Capabilities>,
    pub engine: Option<EngineStatus>,
    pub detected_game: Option<DetectedGame>,
    pub manual_game: Option<String>,
    pub saving: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityCache {
    ffmpeg_path: PathBuf,
    ffmpeg_modified: u64,
    capabilities: Capabilities,
}

fn modified_secs(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

impl Recorder {
    pub fn engine(&self) -> AppResult<Arc<CaptureEngine>> {
        self.engine
            .read()
            .clone()
            .ok_or_else(|| match self.init.read().clone() {
                Some(InitState::Failed { message }) => AppError::NotReady(message),
                _ => AppError::NotReady("the recorder is still starting".into()),
            })
    }

    pub fn ffmpeg(&self) -> AppResult<Ffmpeg> {
        self.ffmpeg
            .read()
            .clone()
            .ok_or_else(|| AppError::NotReady("FFmpeg is not available".into()))
    }

    pub fn capabilities(&self) -> Option<Capabilities> {
        self.capabilities.read().clone()
    }

    pub fn state(&self, app: &AppHandle) -> RecorderState {
        let st = app.state::<AppState>();
        let detected_game = st.games.detected.read().clone();
        let manual_game = st.games.manual.read().clone();
        RecorderState {
            capture_source: self.engine.read().as_ref().map(|e| e.config().video.source),
            init: self.init.read().clone().unwrap_or(InitState::Initializing),
            capabilities: self.capabilities(),
            engine: self.engine.read().as_ref().map(|e| e.status()),
            detected_game,
            manual_game,
            saving: self.saving.load(Ordering::Relaxed),
        }
    }

    pub fn shutdown(&self) {
        if let Some(engine) = self.engine.write().take() {
            if let Some(Err(e)) = engine.shutdown() {
                tracing::error!("finalizing recording at exit failed: {e}");
            }
        }
    }
}

/// Locates FFmpeg, discovers encoders (cached across launches), creates the engine,
/// recovers interrupted recordings and starts Instant Replay if the user enabled it.
/// Runs on a background thread; progress is reported through `recorder-state` events.
pub fn initialize(app: AppHandle, force_probe: bool) {
    std::thread::Builder::new()
        .name("cliplock-recorder-init".into())
        .spawn(move || {
            let st = app.state::<AppState>();
            *st.recorder.init.write() = Some(InitState::Initializing);
            emit_state(&app);
            let result = init_inner(&app, force_probe);
            if let Err(e) = &result {
                tracing::error!("recorder initialization failed: {e}");
            }
            *st.recorder.init.write() = Some(match result {
                Ok(()) => InitState::Ready,
                Err(e) => InitState::Failed {
                    message: e.to_string(),
                },
            });
            emit_state(&app);
            crate::tray::refresh(&app);
        })
        .expect("spawn init thread");
}

fn init_inner(app: &AppHandle, force_probe: bool) -> AppResult<()> {
    let st = app.state::<AppState>();
    st.recorder.shutdown();
    let ffmpeg = Ffmpeg::locate(&st.paths.ffmpeg_dirs)?;
    *st.recorder.ffmpeg.write() = Some(ffmpeg.clone());

    let cache_path = st.paths.data_dir.join("capabilities.json");
    let modified = modified_secs(&ffmpeg.ffmpeg);
    let cached = std::fs::read(&cache_path)
        .ok()
        .and_then(|b| serde_json::from_slice::<CapabilityCache>(&b).ok())
        .filter(|c| {
            !force_probe && c.ffmpeg_path == ffmpeg.ffmpeg && c.ffmpeg_modified == modified
        });
    let caps = match cached {
        Some(c) => c.capabilities,
        None => {
            tracing::info!("probing hardware encoders with {}", ffmpeg.ffmpeg.display());
            let caps = ffmpeg.probe_capabilities()?;
            let cache = CapabilityCache {
                ffmpeg_path: ffmpeg.ffmpeg.clone(),
                ffmpeg_modified: modified,
                capabilities: caps.clone(),
            };
            let _ = std::fs::write(&cache_path, serde_json::to_vec_pretty(&cache)?);
            caps
        }
    };
    tracing::info!(encoders = ?caps.encoders.iter().map(|e| &e.ffmpeg_name).collect::<Vec<_>>(), "capabilities");
    *st.recorder.capabilities.write() = Some(caps.clone());

    let settings = st.settings.read().clone();
    let work_dir = settings.buffer_dir(&st.paths.default_buffer_dir);
    let engine = Arc::new(CaptureEngine::new(
        ffmpeg,
        caps,
        work_dir,
        settings.capture_config(st.games.foreground_hwnd()),
    )?);
    {
        let app = app.clone();
        engine.set_event_handler(Arc::new(move |event| on_engine_event(&app, event)));
    }
    for recovered in engine.recover_interrupted() {
        match recovered {
            Ok(saved) => {
                let clip = add_to_library(
                    app,
                    &saved,
                    ClipKind::Recording,
                    "Recovered recording",
                    None,
                )?;
                notify(
                    app,
                    "Recording recovered",
                    &format!("“{}” was saved after an unexpected shutdown.", clip.title),
                );
            }
            Err(e) => tracing::error!("recovery failed: {e}"),
        }
    }
    *st.recorder.engine.write() = Some(engine.clone());
    if settings.recording.replay_enabled {
        engine.start_replay(settings.recording.replay_seconds)?;
        announce_capture(app);
    }
    Ok(())
}

fn on_engine_event(app: &AppHandle, event: EngineEvent) {
    match &event {
        EngineEvent::RecordingInterrupted {
            clip: Some(saved), ..
        } => {
            if let Ok(clip) = add_to_library(
                app,
                saved,
                ClipKind::Recording,
                "Interrupted recording",
                None,
            ) {
                notify(
                    app,
                    "Recording stopped unexpectedly",
                    &format!("What was captured was saved as “{}”.", clip.title),
                );
            }
        }
        EngineEvent::PipelineFailed {
            error,
            will_retry: false,
        } => {
            notify(app, "Capture stopped", error);
        }
        _ => {}
    }
    let _ = app.emit("engine-event", &event);
    emit_state(app);
    crate::tray::refresh(app);
}

pub fn emit_state(app: &AppHandle) {
    let state = app.state::<AppState>().recorder.state(app);
    let _ = app.emit("recorder-state", state);
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if !app
        .state::<AppState>()
        .settings
        .read()
        .general
        .notifications
    {
        return;
    }
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::debug!("notification failed: {e}");
    }
}

fn cue(app: &AppHandle, c: Cue) {
    let st = app.state::<AppState>();
    if st.settings.read().general.sound_effects {
        sound::play(&st.paths, c);
    }
}

/// Visible acknowledgement whenever capture begins (privacy: no silent recording).
fn announce_capture(app: &AppHandle) {
    let st = app.state::<AppState>();
    let (announce, mic) = {
        let s = st.settings.read();
        (s.privacy.announce_capture, s.audio.mic_enabled)
    };
    if announce {
        let body = if mic {
            "ClipLock is capturing your selected source, system audio and microphone."
        } else {
            "ClipLock is capturing your selected source. Microphone is off."
        };
        notify(app, "ClipLock is capturing", body);
    }
}

fn output_path(app: &AppHandle, game_name: Option<&str>) -> AppResult<PathBuf> {
    let st = app.state::<AppState>();
    let clips_dir = st.settings.read().clips_dir(&st.paths.default_clips_dir);
    let folder = sanitize_file_name(game_name.unwrap_or("Desktop"), "Desktop");
    let dir = clips_dir.join(&folder);
    std::fs::create_dir_all(&dir)?;
    let stamp = Local::now().format("%Y-%m-%d %H-%M-%S");
    Ok(unique_path(&dir, &format!("{folder} {stamp}"), "mp4"))
}

fn default_title(game_name: Option<&str>) -> String {
    let when = Local::now().format("%b %-d, %H:%M");
    format!("{} · {when}", game_name.unwrap_or("Desktop"))
}

/// Adds a saved file to the library with a generated thumbnail.
pub fn add_to_library(
    app: &AppHandle,
    saved: &SavedClip,
    kind: ClipKind,
    title: &str,
    source_clip_id: Option<String>,
) -> AppResult<Clip> {
    let st = app.state::<AppState>();
    let (game_id, game_name) = match &source_clip_id {
        Some(src) => {
            let src = db::get_clip(&st.db.lock(), src)?;
            (src.game_id, src.game_name)
        }
        None => capture_identity(app),
    };
    let new = NewClip {
        title: title.to_string(),
        file_path: saved.path.clone(),
        thumbnail_path: None,
        game_id,
        game_name,
        kind,
        source_clip_id,
        duration_ms: (saved.info.duration_secs * 1000.0).round() as i64,
        width: saved.info.width as i64,
        height: saved.info.height as i64,
        fps: saved.info.fps,
        size_bytes: saved.info.size_bytes as i64,
    };
    let clip = db::insert_clip(&st.db.lock(), &new)?;
    let thumb = st.paths.thumbnails_dir.join(format!("{}.jpg", clip.id));
    let at = (saved.info.duration_secs * 0.3).min(5.0);
    match st.recorder.ffmpeg().and_then(|f| {
        Ok(cliplock_capture::media::thumbnail(
            &f,
            &saved.path,
            &thumb,
            at,
            480,
        )?)
    }) {
        Ok(()) => db::update_media(
            &st.db.lock(),
            &clip.id,
            Some(&thumb),
            saved.info.size_bytes as i64,
        )?,
        Err(e) => tracing::warn!("thumbnail for {} failed: {e}", clip.id),
    }
    let clip = db::get_clip(&st.db.lock(), &clip.id)?;
    let _ = app.emit("clip-added", &clip);
    Ok(clip)
}

pub fn start_replay(app: &AppHandle) -> AppResult<()> {
    let st = app.state::<AppState>();
    let seconds = {
        let mut s = st.settings.write();
        s.recording.replay_enabled = true;
        s.save(&st.paths.config_dir)?;
        s.recording.replay_seconds
    };
    st.recorder.engine()?.start_replay(seconds)?;
    announce_capture(app);
    emit_state(app);
    crate::tray::refresh(app);
    Ok(())
}

pub fn stop_replay(app: &AppHandle) -> AppResult<()> {
    let st = app.state::<AppState>();
    {
        let mut s = st.settings.write();
        s.recording.replay_enabled = false;
        s.save(&st.paths.config_dir)?;
    }
    st.recorder.engine()?.stop_replay();
    emit_state(app);
    crate::tray::refresh(app);
    Ok(())
}

pub fn toggle_replay(app: &AppHandle) -> AppResult<()> {
    if app
        .state::<AppState>()
        .recorder
        .engine()?
        .is_replay_active()
    {
        stop_replay(app)
    } else {
        start_replay(app)
    }
}

/// Saves the Instant Replay buffer. Ignores repeated presses while a save is running.
pub fn save_replay(app: &AppHandle, seconds: Option<u32>) -> AppResult<Clip> {
    let st = app.state::<AppState>();
    let engine = st.recorder.engine()?;
    if st.recorder.saving.swap(true, Ordering::SeqCst) {
        return Err(AppError::Invalid("a clip is already being saved".into()));
    }
    emit_state(app);
    let result = (|| {
        let (_, game_name) = capture_identity(app);
        let path = output_path(app, game_name.as_deref())?;
        let saved = engine.save_replay(&path, seconds)?;
        add_to_library(
            app,
            &saved,
            ClipKind::Replay,
            &default_title(game_name.as_deref()),
            None,
        )
    })();
    st.recorder.saving.store(false, Ordering::SeqCst);
    emit_state(app);
    match &result {
        Ok(clip) => {
            cue(app, Cue::ClipSaved);
            notify(
                app,
                "Clip saved",
                &format!("{} · {:.0}s", clip.title, clip.duration_ms as f64 / 1000.0),
            );
            let _ = app.emit("clip-saved", clip);
        }
        Err(e) => notify(app, "Could not save clip", &e.to_string()),
    }
    result
}

pub fn start_recording(app: &AppHandle) -> AppResult<()> {
    let st = app.state::<AppState>();
    let (_, game_name) = capture_identity(app);
    let path = output_path(app, game_name.as_deref())?;
    st.recorder.engine()?.start_recording(&path)?;
    announce_capture(app);
    cue(app, Cue::RecordingStarted);
    emit_state(app);
    crate::tray::refresh(app);
    Ok(())
}

pub fn stop_recording(app: &AppHandle) -> AppResult<Clip> {
    let st = app.state::<AppState>();
    let saved = st.recorder.engine()?.stop_recording();
    cue(app, Cue::RecordingStopped);
    emit_state(app);
    crate::tray::refresh(app);
    let saved = saved?;
    let (_, game_name) = capture_identity(app);
    let title = format!(
        "{} recording · {}",
        game_name.as_deref().unwrap_or("Desktop"),
        Local::now().format("%b %-d, %H:%M")
    );
    let clip = add_to_library(app, &saved, ClipKind::Recording, &title, None)?;
    notify(app, "Recording saved", &clip.title);
    let _ = app.emit("clip-saved", &clip);
    Ok(clip)
}

pub fn toggle_recording(app: &AppHandle) -> AppResult<()> {
    let recording = app
        .state::<AppState>()
        .recorder
        .engine()?
        .status()
        .recording
        .is_some();
    if recording {
        stop_recording(app).map(|_| ())
    } else {
        start_recording(app)
    }
}

pub fn toggle_pause(app: &AppHandle) -> AppResult<()> {
    let engine = app.state::<AppState>().recorder.engine()?;
    match engine.status().recording {
        Some(r) if r.paused => engine.resume_recording()?,
        Some(_) => engine.pause_recording()?,
        None => return Err(AppError::Invalid("no recording in progress".into())),
    }
    emit_state(app);
    crate::tray::refresh(app);
    Ok(())
}

pub fn toggle_mic_mute(app: &AppHandle) -> AppResult<()> {
    let engine = app.state::<AppState>().recorder.engine()?;
    engine.set_mic_muted(!engine.status().mic_muted);
    emit_state(app);
    Ok(())
}

/// Applies changed settings to the running engine.
pub fn apply_settings(app: &AppHandle, old: &AppSettings, new: &AppSettings) -> AppResult<()> {
    let st = app.state::<AppState>();
    let Ok(engine) = st.recorder.engine() else {
        return Ok(());
    };
    engine.set_config(new.capture_config(st.games.foreground_hwnd()))?;
    if new.recording.replay_seconds != old.recording.replay_seconds {
        engine.set_replay_seconds(new.recording.replay_seconds);
    }
    match (old.recording.replay_enabled, new.recording.replay_enabled) {
        (false, true) => {
            engine.start_replay(new.recording.replay_seconds)?;
            announce_capture(app);
        }
        (true, false) => engine.stop_replay(),
        _ => {}
    }
    emit_state(app);
    Ok(())
}

/// Called by game detection when the game window changes.
pub fn on_game_window_changed(app: &AppHandle) {
    let st = app.state::<AppState>();
    let settings = st.settings.read().clone();
    if settings.recording.capture_target != crate::settings::CaptureTarget::GameWindow {
        return;
    }
    if let Ok(engine) = st.recorder.engine() {
        if engine.status().recording.is_none() {
            if let Err(e) = engine.set_config(settings.capture_config(st.games.foreground_hwnd())) {
                tracing::warn!("could not switch capture to the game window: {e}");
            }
            emit_state(app);
        }
    }
}

fn capture_identity(app: &AppHandle) -> (Option<String>, Option<String>) {
    let st = app.state::<AppState>();
    let source = st.recorder.engine().ok().map(|e| e.config().video.source);
    identity_for_source(source.as_ref(), st.games.current())
}

fn identity_for_source(
    source: Option<&VideoSource>,
    game: (Option<String>, Option<String>),
) -> (Option<String>, Option<String>) {
    if matches!(source, Some(VideoSource::Monitor { .. })) {
        (None, Some("Desktop".into()))
    } else {
        game
    }
}

#[cfg(test)]
mod capture_identity_tests {
    use super::*;

    #[test]
    fn desktop_capture_does_not_inherit_a_running_games_identity() {
        let game = (Some("deadlock".into()), Some("Deadlock".into()));
        assert_eq!(
            identity_for_source(Some(&VideoSource::Monitor { index: 0 }), game.clone()),
            (None, Some("Desktop".into()))
        );
        assert_eq!(
            identity_for_source(Some(&VideoSource::Window { hwnd: 42 }), game.clone()),
            game
        );
    }
}
