use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::{open_input, AudioControls, AudioDeviceKind, InputStream, CHANNELS, SAMPLE_RATE};
use crate::config::AudioConfig;
use crate::error::{CaptureError, Result};

/// How far the mixer runs behind real time. Absorbs device delivery jitter
/// (WASAPI typically delivers in 10 ms packets).
const MIX_LATENCY: Duration = Duration::from_millis(60);
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    /// System + microphone mixed with their volumes applied. Always the first track so
    /// players that only play one track get everything.
    Mixed,
    System,
    Microphone,
}

impl TrackKind {
    pub fn title(self) -> &'static str {
        match self {
            TrackKind::Mixed => "Mixed",
            TrackKind::System => "System audio",
            TrackKind::Microphone => "Microphone",
        }
    }
}

pub struct AudioRuntime {
    /// One loopback TCP port per output track, in track order.
    pub tracks: Vec<(TrackKind, u16)>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    error: Arc<Mutex<Option<String>>>,
}

struct Source {
    kind: AudioDeviceKind,
    input: Box<dyn InputStream>,
    failed: bool,
}

impl AudioRuntime {
    /// Opens the configured devices and starts listening for the encoder. Returns `None`
    /// when no audio input is enabled.
    pub fn start(cfg: &AudioConfig, controls: Arc<AudioControls>) -> Result<Option<Self>> {
        if !cfg.any_enabled() {
            return Ok(None);
        }
        let mut sources = Vec::new();
        if cfg.system.enabled {
            let input = open_input(
                AudioDeviceKind::Output,
                cfg.system.device_id.as_deref(),
                cfg.synthetic,
            )?;
            sources.push(Source {
                kind: AudioDeviceKind::Output,
                input,
                failed: false,
            });
        }
        if cfg.microphone.enabled {
            let input = open_input(
                AudioDeviceKind::Input,
                cfg.microphone.device_id.as_deref(),
                cfg.synthetic,
            )?;
            sources.push(Source {
                kind: AudioDeviceKind::Input,
                input,
                failed: false,
            });
        }

        let mut kinds = vec![TrackKind::Mixed];
        if cfg.separate_tracks && sources.len() > 1 {
            kinds.push(TrackKind::System);
            kinds.push(TrackKind::Microphone);
        }
        let mut listeners = Vec::new();
        let mut tracks = Vec::new();
        for kind in kinds {
            let listener = TcpListener::bind(("127.0.0.1", 0))?;
            tracks.push((kind, listener.local_addr()?.port()));
            listeners.push((kind, listener));
        }

        let stop = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        let thread = {
            let stop = stop.clone();
            let error = error.clone();
            std::thread::Builder::new()
                .name("cliplock-audio-mixer".into())
                .spawn(move || {
                    if let Err(e) = mix_loop(listeners, sources, controls, &stop, &error) {
                        if !stop.load(Ordering::Relaxed) {
                            tracing::error!("audio mixer stopped: {e}");
                            *error.lock() = Some(e.to_string());
                        }
                    }
                })?
        };
        Ok(Some(Self {
            tracks,
            stop,
            thread: Some(thread),
            error,
        }))
    }

    /// A device or mixer error, if one occurred. Device failures do not stop the
    /// recording: the affected source is replaced by silence.
    pub fn error(&self) -> Option<String> {
        self.error.lock().clone()
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for AudioRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

fn try_accept(listener: &TcpListener) -> Result<Option<TcpStream>> {
    match listener.accept() {
        Ok((stream, _)) => {
            stream.set_nonblocking(false)?;
            stream.set_nodelay(true)?;
            stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
            Ok(Some(stream))
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn mix_loop(
    listeners: Vec<(TrackKind, TcpListener)>,
    mut sources: Vec<Source>,
    controls: Arc<AudioControls>,
    stop: &AtomicBool,
    error: &Mutex<Option<String>>,
) -> Result<()> {
    // FFmpeg opens (and probes) its inputs one after another, blocking on each until it
    // has data. So every track is fed from the moment it connects instead of waiting for
    // all of them; the offsets between tracks are a few milliseconds.
    let mut outputs: Vec<(TrackKind, TcpListener, Option<TcpStream>)> = Vec::new();
    for (kind, listener) in listeners {
        listener.set_nonblocking(true)?;
        outputs.push((kind, listener, None));
    }
    let accept_deadline = Instant::now() + ACCEPT_TIMEOUT;
    while outputs[0].2.is_none() {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        if Instant::now() > accept_deadline {
            return Err(CaptureError::Audio(
                "encoder never connected to the audio stream".into(),
            ));
        }
        outputs[0].2 = try_accept(&outputs[0].1)?;
        std::thread::sleep(Duration::from_millis(5));
    }

    for s in &sources {
        s.input.queue().clear();
    }
    let latency_frames = (MIX_LATENCY.as_secs_f64() * SAMPLE_RATE as f64) as usize;
    let max_backlog = latency_frames * 2 + SAMPLE_RATE as usize / 10;
    let start = Instant::now();
    let mut produced: u64 = 0;
    let mut scratch: Vec<Vec<f32>> = sources.iter().map(|_| Vec::new()).collect();
    let mut mixed = Vec::new();
    let mut bytes = Vec::new();

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(10));
        let elapsed = start.elapsed().saturating_sub(MIX_LATENCY);
        let target = (elapsed.as_secs_f64() * SAMPLE_RATE as f64) as u64;
        let frames = (target - produced) as usize;
        if frames == 0 {
            continue;
        }
        let samples = frames * CHANNELS;

        for (source, buf) in sources.iter_mut().zip(scratch.iter_mut()) {
            if !source.failed {
                if let Some(e) = source.input.error() {
                    source.failed = true;
                    tracing::warn!("audio source {:?} failed: {e}", source.kind);
                    *error.lock() = Some(e);
                }
            }
            let queue = source.input.queue();
            if queue.len_frames() > max_backlog + frames {
                queue.trim_to_frames(latency_frames + frames);
            }
            buf.resize(samples, 0.0);
            queue.pop_into(buf);
        }

        let sys_gain = controls.system_volume();
        let mic_gain = if controls.mic_muted() {
            0.0
        } else {
            controls.mic_volume()
        };
        mixed.clear();
        mixed.resize(samples, 0.0);
        for (source, buf) in sources.iter().zip(scratch.iter()) {
            let gain = match source.kind {
                AudioDeviceKind::Output => sys_gain,
                AudioDeviceKind::Input => mic_gain,
            };
            for (m, s) in mixed.iter_mut().zip(buf) {
                *m += s * gain;
            }
        }

        for (kind, listener, stream) in outputs.iter_mut() {
            if stream.is_none() {
                *stream = try_accept(listener)?;
                if stream.is_none() && Instant::now() > accept_deadline {
                    return Err(CaptureError::Audio(
                        "encoder never connected to an audio track".into(),
                    ));
                }
            }
            let Some(stream) = stream.as_mut() else {
                continue;
            };
            let (data, gain): (&[f32], f32) = match kind {
                TrackKind::Mixed => (&mixed, 1.0),
                TrackKind::System => (
                    track_of(&sources, &scratch, AudioDeviceKind::Output),
                    sys_gain,
                ),
                TrackKind::Microphone => (
                    track_of(&sources, &scratch, AudioDeviceKind::Input),
                    mic_gain,
                ),
            };
            bytes.clear();
            bytes.reserve(data.len() * 4);
            for s in data {
                bytes.extend_from_slice(&(s * gain).clamp(-1.0, 1.0).to_le_bytes());
            }
            stream.write_all(&bytes)?;
        }
        produced = target;
    }
    for s in sources.iter_mut() {
        s.input.stop();
    }
    Ok(())
}

fn track_of<'a>(sources: &[Source], scratch: &'a [Vec<f32>], kind: AudioDeviceKind) -> &'a [f32] {
    sources
        .iter()
        .position(|s| s.kind == kind)
        .map(|i| scratch[i].as_slice())
        .unwrap_or(&[])
}
