//! WASAPI capture for Windows: loopback of an output device (game/system audio) and
//! regular capture of an input device (microphone). Uses shared mode with automatic
//! format conversion to 48 kHz stereo float so no resampling is needed downstream.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use parking_lot::Mutex;
use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

use super::{AudioDevice, AudioDeviceKind, InputStream, SampleQueue, CHANNELS, SAMPLE_RATE};
use crate::error::{CaptureError, Result};

fn audio_err(e: impl std::fmt::Display) -> CaptureError {
    CaptureError::Audio(e.to_string())
}

pub fn list_devices() -> Result<Vec<AudioDevice>> {
    let _ = wasapi::initialize_mta();
    let enumerator = DeviceEnumerator::new().map_err(audio_err)?;
    let mut devices = Vec::new();
    for (direction, kind) in [
        (Direction::Render, AudioDeviceKind::Output),
        (Direction::Capture, AudioDeviceKind::Input),
    ] {
        let default_id = enumerator
            .get_default_device(&direction)
            .ok()
            .and_then(|d| d.get_id().ok());
        let collection = enumerator
            .get_device_collection(&direction)
            .map_err(audio_err)?;
        let count = collection.get_nbr_devices().map_err(audio_err)?;
        for i in 0..count {
            let Ok(device) = collection.get_device_at_index(i) else {
                continue;
            };
            let (Ok(id), Ok(name)) = (device.get_id(), device.get_friendlyname()) else {
                continue;
            };
            devices.push(AudioDevice {
                is_default: Some(&id) == default_id.as_ref(),
                id,
                name,
                kind,
            });
        }
    }
    Ok(devices)
}

pub struct WasapiInput {
    queue: Arc<SampleQueue>,
    stop: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    thread: Option<JoinHandle<()>>,
}

impl WasapiInput {
    pub fn start(kind: AudioDeviceKind, device_id: Option<String>) -> Result<Self> {
        let queue = SampleQueue::new(2.0);
        let stop = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        // Initialization happens on the capture thread (COM apartment affinity); wait for
        // it so device errors are reported to the caller synchronously.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<std::result::Result<(), String>>();
        let thread = {
            let queue = queue.clone();
            let stop = stop.clone();
            let error = error.clone();
            std::thread::Builder::new()
                .name(format!("cliplock-wasapi-{kind:?}"))
                .spawn(move || {
                    if let Err(e) = capture_thread(kind, device_id, &queue, &stop, &ready_tx) {
                        let _ = ready_tx.send(Err(e.clone()));
                        *error.lock() = Some(e);
                    }
                })?
        };
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                queue,
                stop,
                error,
                thread: Some(thread),
            }),
            Ok(Err(e)) => Err(CaptureError::Audio(e)),
            Err(_) => Err(CaptureError::Audio(
                "audio thread exited during startup".into(),
            )),
        }
    }
}

fn capture_thread(
    kind: AudioDeviceKind,
    device_id: Option<String>,
    queue: &SampleQueue,
    stop: &AtomicBool,
    ready: &std::sync::mpsc::Sender<std::result::Result<(), String>>,
) -> std::result::Result<(), String> {
    let s = |e: wasapi::WasapiError| e.to_string();
    let _ = wasapi::initialize_mta();
    let enumerator = DeviceEnumerator::new().map_err(s)?;
    let endpoint_direction = match kind {
        AudioDeviceKind::Output => Direction::Render,
        AudioDeviceKind::Input => Direction::Capture,
    };
    let device = match &device_id {
        Some(id) => enumerator.get_device(id).map_err(s)?,
        None => enumerator
            .get_default_device(&endpoint_direction)
            .map_err(s)?,
    };
    let mut client = device.get_iaudioclient().map_err(s)?;
    let format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        SAMPLE_RATE as usize,
        CHANNELS,
        None,
    );
    let (default_period, _) = client.get_device_period().map_err(s)?;
    // Capture streams are always initialized with Direction::Capture; on a render
    // endpoint this enables loopback.
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: default_period * 4,
    };
    client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(s)?;
    let event = client.set_get_eventhandle().map_err(s)?;
    let capture = client.get_audiocaptureclient().map_err(s)?;
    client.start_stream().map_err(s)?;
    let _ = ready.send(Ok(()));

    let mut bytes: VecDeque<u8> = VecDeque::with_capacity(SAMPLE_RATE as usize * 8);
    let mut samples: Vec<f32> = Vec::with_capacity(SAMPLE_RATE as usize * 2);
    while !stop.load(Ordering::Relaxed) {
        // Loopback streams do not signal while nothing is playing; the timeout keeps the
        // loop responsive to `stop` and the mixer fills the gap with silence.
        let _ = event.wait_for_event(100);
        loop {
            match capture.get_next_packet_size().map_err(s)? {
                Some(0) | None => break,
                Some(_) => {
                    bytes.clear();
                    let info = capture.read_from_device_to_deque(&mut bytes).map_err(s)?;
                    if info.flags.silent {
                        samples.extend(std::iter::repeat_n(0.0f32, bytes.len() / 4));
                    } else {
                        let (a, b) = bytes.as_slices();
                        let contiguous: Vec<u8> = [a, b].concat();
                        samples.extend(
                            contiguous
                                .as_chunks::<4>()
                                .0
                                .iter()
                                .map(|c| f32::from_le_bytes(*c)),
                        );
                    }
                }
            }
        }
        if !samples.is_empty() {
            queue.push(&samples);
            samples.clear();
        }
    }
    let _ = client.stop_stream();
    Ok(())
}

impl InputStream for WasapiInput {
    fn queue(&self) -> &Arc<SampleQueue> {
        &self.queue
    }
    fn error(&self) -> Option<String> {
        self.error.lock().clone()
    }
    fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for WasapiInput {
    fn drop(&mut self) {
        self.stop();
    }
}
