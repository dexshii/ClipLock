//! Audio capture and mixing.
//!
//! Each enabled input (system loopback, microphone) runs on its own thread and pushes
//! interleaved stereo `f32` samples at 48 kHz into a [`SampleQueue`]. A mixer thread
//! pulls from the queues on a wall-clock schedule, so the produced sample count always
//! equals elapsed real time: if a device delivers nothing (WASAPI loopback is silent
//! while nothing plays) the mixer inserts silence, and if a device clock runs fast the
//! excess is dropped. This keeps audio locked to the video timeline without relying on
//! device timestamps. The mixed track (and optionally per-source tracks) is streamed as
//! raw `f32le` PCM to the encoder process over loopback TCP sockets.

mod mixer;
mod synthetic;
#[cfg(windows)]
mod wasapi_source;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub use mixer::{AudioRuntime, TrackKind};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;

/// Bounded FIFO of interleaved stereo samples shared between a capture thread and the mixer.
pub struct SampleQueue {
    samples: Mutex<VecDeque<f32>>,
    max_samples: usize,
}

impl SampleQueue {
    pub fn new(max_seconds: f32) -> Arc<Self> {
        let max_samples = (max_seconds * SAMPLE_RATE as f32) as usize * CHANNELS;
        Arc::new(Self {
            samples: Mutex::new(VecDeque::with_capacity(max_samples)),
            max_samples,
        })
    }

    pub fn push(&self, interleaved: &[f32]) {
        let mut q = self.samples.lock();
        q.extend(interleaved.iter().copied());
        if q.len() > self.max_samples {
            let excess = q.len() - self.max_samples;
            q.drain(..excess - excess % CHANNELS);
        }
    }

    /// Fills `out` (interleaved) from the queue; missing samples become silence.
    /// Returns the number of samples that came from the device.
    pub fn pop_into(&self, out: &mut [f32]) -> usize {
        let mut q = self.samples.lock();
        let n = q.len().min(out.len());
        for (dst, src) in out.iter_mut().zip(q.drain(..n)) {
            *dst = src;
        }
        out[n..].fill(0.0);
        n
    }

    pub fn len_frames(&self) -> usize {
        self.samples.lock().len() / CHANNELS
    }

    /// Drops the oldest samples so at most `frames` remain (clock drift correction).
    pub fn trim_to_frames(&self, frames: usize) {
        let mut q = self.samples.lock();
        let keep = frames * CHANNELS;
        if q.len() > keep {
            let drop = q.len() - keep;
            q.drain(..drop);
        }
    }

    pub fn clear(&self) {
        self.samples.lock().clear();
    }
}

/// Live-adjustable mixer controls. Changing these never restarts the encoder.
pub struct AudioControls {
    system_volume: AtomicU32,
    mic_volume: AtomicU32,
    mic_muted: AtomicBool,
}

impl AudioControls {
    pub fn new(system_volume: f32, mic_volume: f32) -> Arc<Self> {
        Arc::new(Self {
            system_volume: AtomicU32::new(system_volume.to_bits()),
            mic_volume: AtomicU32::new(mic_volume.to_bits()),
            mic_muted: AtomicBool::new(false),
        })
    }
    pub fn system_volume(&self) -> f32 {
        f32::from_bits(self.system_volume.load(Ordering::Relaxed))
    }
    pub fn mic_volume(&self) -> f32 {
        f32::from_bits(self.mic_volume.load(Ordering::Relaxed))
    }
    pub fn mic_muted(&self) -> bool {
        self.mic_muted.load(Ordering::Relaxed)
    }
    pub fn set_system_volume(&self, v: f32) {
        self.system_volume
            .store(v.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
    }
    pub fn set_mic_volume(&self, v: f32) {
        self.mic_volume
            .store(v.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
    }
    pub fn set_mic_muted(&self, muted: bool) {
        self.mic_muted.store(muted, Ordering::Relaxed);
    }
}

/// A running capture thread feeding a [`SampleQueue`].
pub trait InputStream: Send {
    fn queue(&self) -> &Arc<SampleQueue>;
    /// Last error reported by the device thread, if it stopped.
    fn error(&self) -> Option<String>;
    fn stop(&mut self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioDeviceKind {
    /// Playback device; captured through WASAPI loopback.
    Output,
    /// Recording device (microphone).
    Input,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub kind: AudioDeviceKind,
    pub is_default: bool,
}

/// Lists active audio endpoints. Returns an empty list on platforms without WASAPI.
pub fn list_devices() -> Vec<AudioDevice> {
    #[cfg(windows)]
    {
        wasapi_source::list_devices().unwrap_or_else(|e| {
            tracing::warn!("listing audio devices failed: {e}");
            Vec::new()
        })
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

pub(crate) fn open_input(
    kind: AudioDeviceKind,
    device_id: Option<&str>,
    synthetic: bool,
) -> crate::error::Result<Box<dyn InputStream>> {
    if synthetic {
        let freq = if kind == AudioDeviceKind::Output {
            440.0
        } else {
            660.0
        };
        return Ok(Box::new(synthetic::SineInput::start(freq)));
    }
    #[cfg(windows)]
    {
        Ok(Box::new(wasapi_source::WasapiInput::start(
            kind,
            device_id.map(str::to_owned),
        )?))
    }
    #[cfg(not(windows))]
    {
        let _ = device_id;
        Err(crate::error::CaptureError::Audio(
            "audio device capture is only implemented for Windows (WASAPI); use synthetic audio for development".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_fills_silence_and_bounds_memory() {
        let q = SampleQueue::new(0.001); // 48 frames
        q.push(&[0.5; 20]);
        let mut out = [1.0f32; 30];
        assert_eq!(q.pop_into(&mut out), 20);
        assert!(out[..20].iter().all(|s| *s == 0.5));
        assert!(out[20..].iter().all(|s| *s == 0.0));
        q.push(&vec![0.1; 500]);
        assert_eq!(q.len_frames(), 48);
        q.trim_to_frames(10);
        assert_eq!(q.len_frames(), 10);
    }

    #[test]
    fn controls_clamp() {
        let c = AudioControls::new(1.0, 1.0);
        c.set_mic_volume(5.0);
        assert_eq!(c.mic_volume(), 2.0);
        c.set_mic_muted(true);
        assert!(c.mic_muted());
    }
}
