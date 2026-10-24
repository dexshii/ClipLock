//! User settings, persisted as JSON in the app config directory.
//!
//! Every section uses `#[serde(default)]` so settings files from older versions load
//! with new fields at their defaults, and unknown fields from newer versions are ignored.

use std::path::{Path, PathBuf};

use cliplock_capture::{
    AudioConfig, AudioInputConfig, CaptureConfig, Codec, EncoderKind, VideoConfig, VideoSource,
};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GeneralSettings {
    pub launch_on_startup: bool,
    pub start_minimized: bool,
    /// Closing the window keeps ClipLock running in the system tray.
    pub close_to_tray: bool,
    pub notifications: bool,
    pub sound_effects: bool,
    pub game_detection: bool,
    pub custom_games: Vec<CustomGame>,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            launch_on_startup: false,
            start_minimized: false,
            close_to_tray: true,
            notifications: true,
            sound_effects: true,
            game_detection: true,
            custom_games: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomGame {
    pub name: String,
    pub executable: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureTarget {
    /// Capture the whole display (most compatible).
    Display,
    /// Capture only the detected game's window (requires Windows.Graphics.Capture
    /// support in the bundled FFmpeg); falls back to the display.
    GameWindow,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RecordingSettings {
    /// Instant Replay is never enabled without the user turning it on.
    pub replay_enabled: bool,
    pub replay_seconds: u32,
    pub capture_target: CaptureTarget,
    pub monitor_index: u32,
}

impl Default for RecordingSettings {
    fn default() -> Self {
        Self {
            replay_enabled: false,
            replay_seconds: 30,
            capture_target: CaptureTarget::Display,
            monitor_index: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoSettings {
    /// `None` = native resolution.
    pub output_height: Option<u32>,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub codec: Codec,
    pub encoder: EncoderKind,
    pub capture_cursor: bool,
}

impl Default for VideoSettings {
    fn default() -> Self {
        let v = VideoConfig::default();
        Self {
            output_height: v.output_height,
            fps: v.fps,
            bitrate_kbps: v.bitrate_kbps,
            codec: v.codec,
            encoder: v.encoder,
            capture_cursor: v.capture_cursor,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioSettings {
    pub system_enabled: bool,
    pub system_device_id: Option<String>,
    pub system_volume: f32,
    /// Off by default; the microphone is only recorded after the user enables it.
    pub mic_enabled: bool,
    pub mic_device_id: Option<String>,
    pub mic_volume: f32,
    pub separate_tracks: bool,
    pub bitrate_kbps: u32,
}

impl Default for AudioSettings {
    fn default() -> Self {
        let a = AudioConfig::default();
        Self {
            system_enabled: a.system.enabled,
            system_device_id: None,
            system_volume: 1.0,
            mic_enabled: a.microphone.enabled,
            mic_device_id: None,
            mic_volume: 1.0,
            separate_tracks: false,
            bitrate_kbps: a.bitrate_kbps,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HotkeySettings {
    pub save_replay: Option<String>,
    pub toggle_recording: Option<String>,
    pub pause_recording: Option<String>,
    pub toggle_replay: Option<String>,
    pub toggle_mic_mute: Option<String>,
}

impl Default for HotkeySettings {
    fn default() -> Self {
        Self {
            save_replay: Some("Alt+F10".into()),
            toggle_recording: Some("Alt+F9".into()),
            pause_recording: Some("Alt+F8".into()),
            toggle_replay: Some("Ctrl+Shift+F10".into()),
            toggle_mic_mute: None,
        }
    }
}

impl HotkeySettings {
    pub fn entries(&self) -> Vec<(HotkeyAction, &str)> {
        [
            (HotkeyAction::SaveReplay, &self.save_replay),
            (HotkeyAction::ToggleRecording, &self.toggle_recording),
            (HotkeyAction::PauseRecording, &self.pause_recording),
            (HotkeyAction::ToggleReplay, &self.toggle_replay),
            (HotkeyAction::ToggleMicMute, &self.toggle_mic_mute),
        ]
        .into_iter()
        .filter_map(|(a, k)| {
            k.as_deref()
                .filter(|k| !k.trim().is_empty())
                .map(|k| (a, k))
        })
        .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyAction {
    SaveReplay,
    ToggleRecording,
    PauseRecording,
    ToggleReplay,
    ToggleMicMute,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StorageSettings {
    /// Where clips are saved. `None` = `Videos/ClipLock`.
    pub clips_dir: Option<PathBuf>,
    /// Where the replay buffer lives. `None` = app data directory.
    pub buffer_dir: Option<PathBuf>,
    /// Warn when the library grows beyond this size.
    pub library_warning_gb: u32,
}

impl Default for StorageSettings {
    fn default() -> Self {
        Self {
            clips_dir: None,
            buffer_dir: None,
            library_warning_gb: 50,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UploadSettings {
    /// Base URL of the ClipLock server (official or self-hosted). Empty = cloud
    /// features disabled (local-only mode).
    pub server_url: String,
    pub default_visibility: String,
    pub allow_download: bool,
}

impl Default for UploadSettings {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            default_visibility: "unlisted".into(),
            allow_download: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacySettings {
    /// Show a notification whenever capture starts.
    pub announce_capture: bool,
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            announce_capture: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub general: GeneralSettings,
    pub recording: RecordingSettings,
    pub video: VideoSettings,
    pub audio: AudioSettings,
    pub hotkeys: HotkeySettings,
    pub storage: StorageSettings,
    pub uploads: UploadSettings,
    pub privacy: PrivacySettings,
    /// Set once the first-run privacy notice has been acknowledged.
    pub onboarding_complete: bool,
}

pub const SETTINGS_FILE: &str = "settings.json";

impl AppSettings {
    pub fn validate(&self) -> AppResult<()> {
        let invalid = |m: String| Err(AppError::Invalid(m));
        let r = &self.recording;
        if !(5..=1200).contains(&r.replay_seconds) {
            return invalid(format!(
                "replay length must be 5–1200 seconds (got {})",
                r.replay_seconds
            ));
        }
        if !self.uploads.server_url.is_empty() {
            let url = url::Url::parse(&self.uploads.server_url)
                .map_err(|_| AppError::Invalid("server URL is not a valid URL".into()))?;
            let local = matches!(
                url.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("::1")
            );
            if url.scheme() != "https" && !(url.scheme() == "http" && local) {
                return invalid(
                    "server URL must use https:// (http:// is only allowed for localhost)".into(),
                );
            }
        }
        if !["private", "unlisted", "public"].contains(&self.uploads.default_visibility.as_str()) {
            return invalid("unknown default visibility".into());
        }
        let keys: Vec<String> = self
            .hotkeys
            .entries()
            .iter()
            .map(|(_, k)| k.to_ascii_lowercase().replace(' ', ""))
            .collect();
        for (i, k) in keys.iter().enumerate() {
            if keys[..i].contains(k) {
                return invalid(format!("hotkey {k} is assigned twice"));
            }
        }
        self.capture_config(None).validate()?;
        Ok(())
    }

    pub fn clips_dir(&self, default: &Path) -> PathBuf {
        self.storage
            .clips_dir
            .clone()
            .unwrap_or_else(|| default.to_path_buf())
    }

    pub fn buffer_dir(&self, default: &Path) -> PathBuf {
        self.storage
            .buffer_dir
            .clone()
            .unwrap_or_else(|| default.to_path_buf())
    }

    /// Engine configuration for the current settings. `game_hwnd` is the detected game
    /// window, used when capturing the game window instead of the display.
    pub fn capture_config(&self, game_hwnd: Option<u64>) -> CaptureConfig {
        let source = match (self.recording.capture_target, game_hwnd) {
            (CaptureTarget::GameWindow, Some(hwnd)) => VideoSource::Window { hwnd },
            _ => VideoSource::Monitor {
                index: self.recording.monitor_index,
            },
        };
        let v = &self.video;
        let a = &self.audio;
        CaptureConfig {
            video: VideoConfig {
                source,
                output_height: v.output_height,
                fps: v.fps,
                bitrate_kbps: v.bitrate_kbps,
                codec: v.codec,
                encoder: v.encoder,
                capture_cursor: v.capture_cursor,
            },
            audio: AudioConfig {
                system: AudioInputConfig {
                    enabled: a.system_enabled,
                    device_id: a.system_device_id.clone(),
                    volume: a.system_volume,
                },
                microphone: AudioInputConfig {
                    enabled: a.mic_enabled,
                    device_id: a.mic_device_id.clone(),
                    volume: a.mic_volume,
                },
                separate_tracks: a.separate_tracks,
                bitrate_kbps: a.bitrate_kbps,
                synthetic: std::env::var_os("CLIPLOCK_SYNTHETIC_AUDIO").is_some(),
            },
            ..CaptureConfig::default()
        }
    }

    /// Loads settings, falling back to the backup copy and then to defaults if the file
    /// is missing or corrupt (a corrupt file is kept aside for inspection).
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join(SETTINGS_FILE);
        let backup = path.with_extension("json.bak");
        for candidate in [&path, &backup] {
            match std::fs::read(candidate) {
                Ok(bytes) => match serde_json::from_slice::<AppSettings>(&bytes) {
                    Ok(s) if s.validate().is_ok() => return s,
                    Ok(_) | Err(_) => {
                        tracing::warn!(
                            "settings file {} is invalid; ignoring it",
                            candidate.display()
                        );
                        let _ = std::fs::rename(candidate, candidate.with_extension("corrupt"));
                    }
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => tracing::warn!("cannot read {}: {e}", candidate.display()),
            }
        }
        Self::default()
    }

    /// Writes settings atomically, keeping the previous version as a backup.
    pub fn save(&self, config_dir: &Path) -> AppResult<()> {
        std::fs::create_dir_all(config_dir)?;
        let path = config_dir.join(SETTINGS_FILE);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        if path.exists() {
            let _ = std::fs::copy(&path, path.with_extension("json.bak"));
        }
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_private_and_valid() {
        let s = AppSettings::default();
        s.validate().unwrap();
        assert!(!s.recording.replay_enabled, "Instant Replay must be opt-in");
        assert!(!s.audio.mic_enabled, "microphone must be opt-in");
        assert!(s.uploads.server_url.is_empty(), "local-only by default");
        assert_eq!(s.hotkeys.save_replay.as_deref(), Some("Alt+F10"));
    }

    #[test]
    fn round_trips_and_tolerates_partial_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = AppSettings::default();
        s.recording.replay_seconds = 60;
        s.save(dir.path()).unwrap();
        assert_eq!(AppSettings::load(dir.path()), s);

        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{"recording":{"replaySeconds":120},"futureField":1}"#,
        )
        .unwrap();
        let loaded = AppSettings::load(dir.path());
        assert_eq!(loaded.recording.replay_seconds, 120);
        assert_eq!(loaded.video, VideoSettings::default());
    }

    #[test]
    fn corrupt_file_falls_back_to_backup() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = AppSettings::default();
        s.recording.replay_seconds = 45;
        s.save(dir.path()).unwrap();
        s.save(dir.path()).unwrap(); // creates the backup
        std::fs::write(dir.path().join(SETTINGS_FILE), b"{ not json").unwrap();
        assert_eq!(AppSettings::load(dir.path()).recording.replay_seconds, 45);
    }

    #[test]
    fn validation_rejects_insecure_server_and_duplicate_hotkeys() {
        let mut s = AppSettings::default();
        s.uploads.server_url = "http://clips.example.com".into();
        assert!(s.validate().is_err());
        s.uploads.server_url = "http://localhost:8080".into();
        s.validate().unwrap();
        s.uploads.server_url = "https://clips.example.com".into();
        s.validate().unwrap();
        s.hotkeys.toggle_recording = Some("alt + f10".into());
        assert!(s.validate().is_err());
    }

    #[test]
    fn game_window_target_uses_hwnd_when_available() {
        let mut s = AppSettings::default();
        s.recording.capture_target = CaptureTarget::GameWindow;
        assert_eq!(
            s.capture_config(Some(42)).video.source,
            VideoSource::Window { hwnd: 42 }
        );
        assert_eq!(
            s.capture_config(None).video.source,
            VideoSource::Monitor { index: 0 }
        );
    }

    #[test]
    fn desktop_target_uses_selected_monitor_even_with_a_detected_game() {
        let mut s = AppSettings::default();
        s.recording.capture_target = CaptureTarget::Display;
        s.recording.monitor_index = 1;
        assert_eq!(
            s.capture_config(Some(42)).video.source,
            VideoSource::Monitor { index: 1 }
        );
        let dir = tempfile::tempdir().unwrap();
        s.save(dir.path()).unwrap();
        assert_eq!(AppSettings::load(dir.path()).recording.monitor_index, 1);
    }
}
