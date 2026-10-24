//! Generated tones paced in real time. Lets the full pipeline be exercised on machines
//! without audio hardware (CI, Linux development).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::{InputStream, SampleQueue, CHANNELS, SAMPLE_RATE};

pub struct SineInput {
    queue: Arc<SampleQueue>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl SineInput {
    pub fn start(freq: f32) -> Self {
        let queue = SampleQueue::new(2.0);
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let queue = queue.clone();
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("cliplock-sine".into())
                .spawn(move || {
                    let start = Instant::now();
                    let mut produced: u64 = 0;
                    let mut phase = 0.0f32;
                    let step = freq * std::f32::consts::TAU / SAMPLE_RATE as f32;
                    let mut buf = Vec::new();
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(10));
                        let target = (start.elapsed().as_secs_f64() * SAMPLE_RATE as f64) as u64;
                        let frames = (target - produced) as usize;
                        buf.clear();
                        for _ in 0..frames {
                            let s = phase.sin() * 0.2;
                            phase = (phase + step) % std::f32::consts::TAU;
                            buf.extend(std::iter::repeat_n(s, CHANNELS));
                        }
                        queue.push(&buf);
                        produced = target;
                    }
                })
                .expect("spawn sine thread")
        };
        Self {
            queue,
            stop,
            thread: Some(thread),
        }
    }
}

impl InputStream for SineInput {
    fn queue(&self) -> &Arc<SampleQueue> {
        &self.queue
    }
    fn error(&self) -> Option<String> {
        None
    }
    fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for SineInput {
    fn drop(&mut self) {
        self.stop();
    }
}
