use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("ffmpeg executable not found (looked in: {0:?})")]
    FfmpegNotFound(Vec<PathBuf>),
    #[error("ffmpeg failed: {0}")]
    Ffmpeg(String),
    #[error("no usable video encoder was found")]
    NoEncoder,
    #[error("the requested encoder `{0}` is not available on this system")]
    EncoderUnavailable(String),
    #[error("the replay buffer is not running")]
    ReplayNotRunning,
    #[error("a recording is already in progress")]
    AlreadyRecording,
    #[error("no recording is in progress")]
    NotRecording,
    #[error("not enough footage buffered yet")]
    NothingBuffered,
    #[error("timed out waiting for the encoder")]
    Timeout,
    #[error("the capture pipeline stopped unexpectedly: {0}")]
    PipelineDied(String),
    #[error("invalid configuration: {0}")]
    InvalidConfig(String),
    #[error("audio error: {0}")]
    Audio(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, CaptureError>;
