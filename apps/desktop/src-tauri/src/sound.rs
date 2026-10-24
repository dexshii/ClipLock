//! Short feedback sounds, played natively so they work while the window is hidden.

use std::path::Path;

#[derive(Debug, Clone, Copy)]
pub enum Cue {
    ClipSaved,
    RecordingStarted,
    RecordingStopped,
}

impl Cue {
    fn file(self) -> &'static str {
        match self {
            Cue::ClipSaved => "sounds/clip-saved.wav",
            Cue::RecordingStarted => "sounds/recording-start.wav",
            Cue::RecordingStopped => "sounds/recording-stop.wav",
        }
    }
}

pub fn play(paths: &crate::paths::AppPaths, cue: Cue) {
    play_file(&paths.resource(cue.file()));
}

#[cfg(windows)]
fn play_file(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let _ = PlaySoundW(
            PCWSTR(wide.as_ptr()),
            None,
            SND_ASYNC | SND_FILENAME | SND_NODEFAULT,
        );
    }
}

#[cfg(not(windows))]
fn play_file(path: &Path) {
    tracing::debug!(
        "sound cue {} (playback only implemented on Windows)",
        path.display()
    );
}
