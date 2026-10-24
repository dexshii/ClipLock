//! ClipLock's recording engine.
//!
//! Capture and encoding run in a separate FFmpeg process (GPU capture through the
//! Desktop Duplication API or Windows.Graphics.Capture, hardware encoding through
//! NVENC/AMF/Quick Sync/Media Foundation). This crate orchestrates that process, feeds
//! it mixed WASAPI audio, and manages the keyframe-aligned segment buffer that powers
//! Instant Replay and manual recording.

pub mod args;
pub mod audio;
pub mod config;
pub mod engine;
pub mod error;
pub mod ffmpeg;
pub mod media;
pub mod pipeline;
pub mod platform;
pub mod segments;

pub use config::{AudioConfig, AudioInputConfig, CaptureConfig, Codec, EncoderKind, VideoConfig, VideoSource};
pub use engine::{CaptureEngine, EngineEvent, EngineStatus, SavedClip};
pub use error::{CaptureError, Result};
pub use ffmpeg::{Capabilities, EncoderInfo, Ffmpeg};
pub use media::{EditSpec, MediaInfo};
