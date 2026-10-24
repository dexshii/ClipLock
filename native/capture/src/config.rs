//! User-facing capture configuration. Everything here is serializable so the desktop
//! app can persist it as-is.

use serde::{Deserialize, Serialize};

use crate::error::{CaptureError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    H264,
    Hevc,
    Av1,
}

/// Which encoder family to use. `Auto` picks the best available hardware encoder and
/// falls back to software.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum EncoderKind {
    Auto,
    /// NVIDIA NVENC
    Nvenc,
    /// AMD Advanced Media Framework
    Amf,
    /// Intel Quick Sync Video
    Qsv,
    /// Windows Media Foundation (hardware MFT when present, otherwise Microsoft's software MFT)
    MediaFoundation,
    /// libx264 / libx265 / libsvtav1 (only in GPL FFmpeg builds)
    Software,
    /// Cisco OpenH264 (H.264 only)
    OpenH264,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum VideoSource {
    /// Capture a whole monitor. Uses the Desktop Duplication API (`ddagrab`) or
    /// Windows.Graphics.Capture (`gfxcapture`) when the FFmpeg build has it.
    #[serde(rename_all = "camelCase")]
    Monitor { index: u32 },
    /// Capture a single window through Windows.Graphics.Capture. Requires an FFmpeg
    /// build with the `gfxcapture` filter.
    #[serde(rename_all = "camelCase")]
    Window { hwnd: u64 },
    /// Synthetic test pattern. Used for automated tests and development on
    /// non-Windows machines.
    TestPattern,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoConfig {
    pub source: VideoSource,
    /// Output height in pixels (720, 1080, 1440, ...). `None` keeps the native size.
    pub output_height: Option<u32>,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub codec: Codec,
    pub encoder: EncoderKind,
    pub capture_cursor: bool,
}

impl Default for VideoConfig {
    fn default() -> Self {
        Self {
            source: VideoSource::Monitor { index: 0 },
            output_height: Some(1080),
            fps: 60,
            bitrate_kbps: 20_000,
            codec: Codec::H264,
            encoder: EncoderKind::Auto,
            capture_cursor: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputConfig {
    pub enabled: bool,
    /// Endpoint id. `None` means the current default device.
    pub device_id: Option<String>,
    /// Linear gain, 0.0 – 2.0.
    pub volume: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfig {
    /// Game / system audio (WASAPI loopback of the output device).
    pub system: AudioInputConfig,
    /// Microphone. Disabled by default: ClipLock never records the microphone unless the
    /// user explicitly enables it.
    pub microphone: AudioInputConfig,
    /// Write system audio and microphone as extra tracks after the mixed track.
    pub separate_tracks: bool,
    pub bitrate_kbps: u32,
    /// Development/testing only: replace devices with generated tones.
    #[serde(default)]
    pub synthetic: bool,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            system: AudioInputConfig {
                enabled: true,
                device_id: None,
                volume: 1.0,
            },
            microphone: AudioInputConfig {
                enabled: false,
                device_id: None,
                volume: 1.0,
            },
            separate_tracks: false,
            bitrate_kbps: 160,
            synthetic: false,
        }
    }
}

impl AudioConfig {
    pub fn any_enabled(&self) -> bool {
        self.system.enabled || self.microphone.enabled
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureConfig {
    pub video: VideoConfig,
    pub audio: AudioConfig,
    /// Maximum distance between keyframes. Segments always start on a keyframe, so this
    /// is also the precision of replay starts and pause/resume cuts.
    pub keyframe_interval_secs: u32,
    /// Target length of each buffer segment.
    pub segment_secs: u32,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            video: VideoConfig::default(),
            audio: AudioConfig::default(),
            keyframe_interval_secs: 1,
            segment_secs: 1,
        }
    }
}

impl CaptureConfig {
    pub fn validate(&self) -> Result<()> {
        let v = &self.video;
        if !(1..=240).contains(&v.fps) {
            return Err(CaptureError::InvalidConfig(format!(
                "fps {} out of range",
                v.fps
            )));
        }
        if !(500..=200_000).contains(&v.bitrate_kbps) {
            return Err(CaptureError::InvalidConfig(format!(
                "bitrate {} kbps out of range",
                v.bitrate_kbps
            )));
        }
        if let Some(h) = v.output_height {
            if !(144..=4320).contains(&h) || h % 2 != 0 {
                return Err(CaptureError::InvalidConfig(format!(
                    "output height {h} is invalid"
                )));
            }
        }
        if self.keyframe_interval_secs == 0 || self.segment_secs < self.keyframe_interval_secs {
            return Err(CaptureError::InvalidConfig(
                "segment length must be at least one keyframe interval".into(),
            ));
        }
        for (name, input) in [
            ("system", &self.audio.system),
            ("microphone", &self.audio.microphone),
        ] {
            if !(0.0..=2.0).contains(&input.volume) || input.volume.is_nan() {
                return Err(CaptureError::InvalidConfig(format!(
                    "{name} volume out of range"
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_microphone_is_off() {
        let c = CaptureConfig::default();
        c.validate().unwrap();
        assert!(!c.audio.microphone.enabled, "microphone must be opt-in");
    }

    #[test]
    fn rejects_bad_values() {
        let mut c = CaptureConfig::default();
        c.video.fps = 0;
        assert!(c.validate().is_err());
        let mut c = CaptureConfig::default();
        c.video.output_height = Some(1081);
        assert!(c.validate().is_err());
        let c = CaptureConfig {
            segment_secs: 0,
            ..CaptureConfig::default()
        };
        assert!(c.validate().is_err());
    }

    #[test]
    fn serde_round_trip_uses_camel_case() {
        let c = CaptureConfig::default();
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"keyframeIntervalSecs\""));
        assert!(json.contains("\"type\":\"monitor\""));
        let back: CaptureConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
    }
}
