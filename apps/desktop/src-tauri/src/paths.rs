use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Filesystem locations used by the app. Everything except the clip folder lives in
/// the per-user application directories.
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub thumbnails_dir: PathBuf,
    pub default_clips_dir: PathBuf,
    pub default_buffer_dir: PathBuf,
    pub resource_dir: PathBuf,
    /// Directories searched for the bundled FFmpeg executables.
    pub ffmpeg_dirs: Vec<PathBuf>,
}

impl AppPaths {
    pub fn resolve(app: &AppHandle) -> tauri::Result<Self> {
        let p = app.path();
        let config_dir = p.app_config_dir()?;
        let data_dir = p.app_local_data_dir()?;
        let log_dir = p.app_log_dir()?;
        let videos = p.video_dir().or_else(|_| p.home_dir())?;
        let resource_dir = p.resource_dir()?;
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(Path::to_path_buf));
        let mut ffmpeg_dirs: Vec<PathBuf> = exe_dir.into_iter().collect();
        ffmpeg_dirs.push(resource_dir.clone());
        // `tauri dev` runs from target/debug; sidecars live in src-tauri/binaries.
        ffmpeg_dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
        let paths = Self {
            thumbnails_dir: data_dir.join("thumbnails"),
            default_buffer_dir: data_dir.join("buffer"),
            default_clips_dir: videos.join("ClipLock"),
            config_dir,
            data_dir,
            log_dir,
            resource_dir,
            ffmpeg_dirs,
        };
        for dir in [
            &paths.config_dir,
            &paths.data_dir,
            &paths.log_dir,
            &paths.thumbnails_dir,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(paths)
    }

    pub fn resource(&self, rel: &str) -> PathBuf {
        let bundled = self.resource_dir.join(rel);
        if bundled.exists() {
            return bundled;
        }
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(rel)
    }
}
