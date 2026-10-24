//! Builds the FFmpeg command line for a capture session. Kept free of side effects so
//! the exact arguments can be unit-tested on any platform.

use std::path::Path;

use crate::audio::{TrackKind, CHANNELS, SAMPLE_RATE};
use crate::config::{CaptureConfig, EncoderKind, VideoSource};
use crate::ffmpeg::{Capabilities, EncoderInfo};
use crate::segments::{segment_pattern, SEGMENT_LIST};

pub struct SessionPlan<'a> {
    pub config: &'a CaptureConfig,
    pub caps: &'a Capabilities,
    pub encoder: &'a EncoderInfo,
    /// Keep frames on the GPU between capture and encode when possible. Disabled as a
    /// fallback when the zero-copy path fails (e.g. capture and encoder on different GPUs).
    pub gpu_path: bool,
    pub session_dir: &'a Path,
    pub audio_tracks: &'a [(TrackKind, u16)],
}

fn push<S: Into<String>>(args: &mut Vec<String>, items: impl IntoIterator<Item = S>) {
    args.extend(items.into_iter().map(Into::into));
}

/// Width for test-pattern sources (16:9, even).
fn test_pattern_size(height: Option<u32>) -> (u32, u32) {
    let h = height.unwrap_or(720);
    let w = (h * 16 / 9 + 1) & !1;
    (w, h)
}

/// Whether the source yields D3D11 GPU frames (Windows capture filters).
pub fn is_d3d11_source(source: &VideoSource) -> bool {
    cfg!(windows) && matches!(source, VideoSource::Monitor { .. } | VideoSource::Window { .. })
}

pub fn video_input(config: &CaptureConfig, caps: &Capabilities) -> Vec<String> {
    let v = &config.video;
    let cursor = u8::from(v.capture_cursor);
    match &v.source {
        // Development convenience on Linux/X11: capture the X display (CPU frames).
        VideoSource::Monitor { .. } | VideoSource::Window { .. } if !cfg!(windows) => vec![
            "-f".into(),
            "x11grab".into(),
            "-framerate".into(),
            v.fps.to_string(),
            "-draw_mouse".into(),
            cursor.to_string(),
            "-i".into(),
            std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into()),
        ],
        VideoSource::Monitor { index } if caps.has_ddagrab || !caps.has_gfxcapture => vec![
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("ddagrab=output_idx={index}:framerate={}:draw_mouse={cursor}", v.fps),
        ],
        VideoSource::Monitor { index } => vec![
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("gfxcapture=monitor_idx={index}:max_framerate={}:capture_cursor={cursor}", v.fps),
        ],
        VideoSource::Window { hwnd } => vec![
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("gfxcapture=hwnd={hwnd}:max_framerate={}:capture_cursor={cursor}:resize_mode=scale_aspect", v.fps),
        ],
        VideoSource::TestPattern => {
            let (w, h) = test_pattern_size(v.output_height);
            vec![
                "-re".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!("testsrc2=size={w}x{h}:rate={}", v.fps),
            ]
        }
    }
}

/// The `-vf` chain between capture and encoder.
pub fn video_filter(plan: &SessionPlan) -> Option<String> {
    let v = &plan.config.video;
    let kind = plan.encoder.kind;
    let sw_format = if kind == EncoderKind::OpenH264 { "yuv420p" } else { "nv12" };
    // Never upscale: the output is at most the source height.
    let height = v.output_height.map_or_else(|| "ih".to_string(), |h| format!("min({h}\\,ih)"));
    let mut chain: Vec<String> = Vec::new();

    if !is_d3d11_source(&v.source) {
        if !matches!(v.source, VideoSource::TestPattern) {
            chain.push(format!("scale=-2:{height}"));
        }
        // Software encoders get yuv420p for maximum player compatibility.
        let fmt = if plan.encoder.hardware { sw_format } else { "yuv420p" };
        chain.push(format!("format={fmt}"));
        return Some(chain.join(","));
    }

    // gfxcapture only emits frames when the window changes; make the rate constant.
    if matches!(v.source, VideoSource::Window { .. }) {
        chain.push(format!("fps={}", v.fps));
    }

    let gpu_encoder = matches!(kind, EncoderKind::Nvenc | EncoderKind::Amf | EncoderKind::Qsv);
    if plan.gpu_path && gpu_encoder && plan.caps.has_scale_d3d11 {
        // Scale and convert BGRA → NV12 on the GPU with the D3D11 video processor.
        chain.push(format!("scale_d3d11=width=-2:height={height}:format=nv12"));
        if kind == EncoderKind::Qsv {
            chain.push("hwmap=derive_device=qsv,format=qsv".into());
        }
    } else if plan.gpu_path && gpu_encoder && v.output_height.is_none() {
        // NVENC and AMF accept D3D11 BGRA textures directly: zero copy, no scaling.
        if kind == EncoderKind::Qsv {
            chain.push("hwmap=derive_device=qsv,format=qsv".into());
        }
    } else {
        // Portable path: copy frames to system memory and convert there. Costs CPU and
        // memory bandwidth; used for software encoders and as a fallback.
        chain.push("hwdownload".into());
        chain.push("format=bgra".into());
        if v.output_height.is_some() {
            chain.push(format!("scale=-2:{height}:flags=bilinear"));
        }
        let fmt = if plan.encoder.hardware { sw_format } else { "yuv420p" };
        chain.push(format!("format={fmt}"));
    }
    if chain.is_empty() {
        None
    } else {
        Some(chain.join(","))
    }
}

/// Encoder options: bitrate-targeted VBR, no B-frames (lower latency and simpler
/// cutting), and a fixed keyframe cadence so segments can be cut on time.
pub fn encoder_args(plan: &SessionPlan) -> Vec<String> {
    let v = &plan.config.video;
    let enc = plan.encoder;
    let b = v.bitrate_kbps;
    let gop = v.fps * plan.config.keyframe_interval_secs;
    let mut a: Vec<String> = vec!["-c:v".into(), enc.ffmpeg_name.clone()];
    let rate = [
        "-b:v".to_string(),
        format!("{b}k"),
        "-maxrate".into(),
        format!("{}k", b * 3 / 2),
        "-bufsize".into(),
        format!("{}k", b * 2),
    ];
    match enc.kind {
        EncoderKind::Nvenc => {
            push(&mut a, ["-preset", "p4", "-tune", "hq", "-rc", "vbr", "-forced-idr", "1"]);
            push(&mut a, rate);
        }
        EncoderKind::Amf => {
            push(&mut a, ["-usage", "transcoding", "-quality", "balanced", "-rc", "vbr_peak"]);
            push(&mut a, rate);
        }
        EncoderKind::Qsv => {
            push(&mut a, ["-preset", "veryfast", "-look_ahead", "0", "-forced_idr", "1"]);
            push(&mut a, rate);
        }
        EncoderKind::MediaFoundation => {
            push(&mut a, ["-rate_control", "u_vbr", "-scenario", "camera_record"]);
            if enc.hardware {
                push(&mut a, ["-hw_encoding", "1"]);
            }
            push(&mut a, ["-b:v".to_string(), format!("{b}k")]);
        }
        EncoderKind::Software => {
            let preset = if enc.ffmpeg_name == "libsvtav1" { "10" } else { "veryfast" };
            push(&mut a, ["-preset", preset]);
            push(&mut a, rate);
        }
        EncoderKind::OpenH264 | EncoderKind::Auto => {
            push(&mut a, ["-b:v".to_string(), format!("{b}k")]);
        }
    }
    push(&mut a, ["-bf".to_string(), "0".into(), "-g".into(), gop.to_string()]);
    push(
        &mut a,
        [
            "-force_key_frames".to_string(),
            format!("expr:gte(t,n_forced*{})", plan.config.keyframe_interval_secs),
        ],
    );
    a
}

pub fn build_args(plan: &SessionPlan) -> Vec<String> {
    let cfg = plan.config;
    let mut args: Vec<String> = Vec::new();
    push(&mut args, ["-y", "-loglevel", "warning", "-nostats", "-progress", "pipe:1", "-stats_period", "0.5"]);

    args.extend(video_input(cfg, plan.caps));
    for (_, port) in plan.audio_tracks {
        push(
            &mut args,
            [
                "-thread_queue_size".to_string(),
                "4096".into(),
                "-f".into(),
                "f32le".into(),
                "-ar".into(),
                SAMPLE_RATE.to_string(),
                "-ac".into(),
                CHANNELS.to_string(),
                "-i".into(),
                format!("tcp://127.0.0.1:{port}"),
            ],
        );
    }

    push(&mut args, ["-map", "0:v:0"]);
    for (i, _) in plan.audio_tracks.iter().enumerate() {
        push(&mut args, ["-map".to_string(), format!("{}:a:0", i + 1)]);
    }
    if let Some(vf) = video_filter(plan) {
        push(&mut args, ["-vf".to_string(), vf]);
    }
    args.extend(encoder_args(plan));
    if !plan.audio_tracks.is_empty() {
        push(&mut args, ["-c:a".to_string(), "aac".into(), "-b:a".into(), format!("{}k", cfg.audio.bitrate_kbps)]);
        for (i, (kind, _)) in plan.audio_tracks.iter().enumerate() {
            push(&mut args, [format!("-metadata:s:a:{i}"), format!("title={}", kind.title())]);
        }
    }

    push(
        &mut args,
        [
            "-f".to_string(),
            "segment".into(),
            "-segment_format".into(),
            "mpegts".into(),
            "-segment_time".into(),
            cfg.segment_secs.to_string(),
            "-segment_list".into(),
            plan.session_dir.join(SEGMENT_LIST).to_string_lossy().into_owned(),
            "-segment_list_type".into(),
            "csv".into(),
            "-segment_list_flags".into(),
            "+live".into(),
            "-reset_timestamps".into(),
            "1".into(),
            segment_pattern(plan.session_dir).to_string_lossy().into_owned(),
        ],
    );
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Codec;
    use std::path::PathBuf;

    fn caps(scale_d3d11: bool) -> Capabilities {
        Capabilities {
            ffmpeg_version: "t".into(),
            encoders: vec![],
            has_ddagrab: true,
            has_gfxcapture: true,
            has_scale_d3d11: scale_d3d11,
            has_aac: true,
        }
    }

    fn enc(kind: EncoderKind, name: &str, hardware: bool) -> EncoderInfo {
        EncoderInfo { kind, codec: Codec::H264, ffmpeg_name: name.into(), hardware }
    }

    #[test]
    #[cfg(windows)]
    fn nvenc_with_gpu_scaling_stays_on_gpu() {
        let config = CaptureConfig::default();
        let caps = caps(true);
        let e = enc(EncoderKind::Nvenc, "h264_nvenc", true);
        let dir = PathBuf::from("buf");
        let plan = SessionPlan { config: &config, caps: &caps, encoder: &e, gpu_path: true, session_dir: &dir, audio_tracks: &[] };
        assert_eq!(video_filter(&plan).unwrap(), "scale_d3d11=width=-2:height=min(1080\\,ih):format=nv12");
        let args = build_args(&plan);
        let joined = args.join(" ");
        assert!(joined.contains("ddagrab=output_idx=0:framerate=60:draw_mouse=0"));
        assert!(joined.contains("-c:v h264_nvenc"));
        assert!(joined.contains("-g 60"));
        assert!(joined.contains("-segment_time 1"));
        assert!(!joined.contains("hwdownload"));
    }

    #[test]
    #[cfg(windows)]
    fn falls_back_to_cpu_conversion() {
        let mut config = CaptureConfig::default();
        config.video.output_height = Some(720);
        let caps = caps(false);
        let e = enc(EncoderKind::Nvenc, "h264_nvenc", true);
        let dir = PathBuf::from("buf");
        let plan = SessionPlan { config: &config, caps: &caps, encoder: &e, gpu_path: true, session_dir: &dir, audio_tracks: &[] };
        assert_eq!(video_filter(&plan).unwrap(), "hwdownload,format=bgra,scale=-2:min(720\\,ih):flags=bilinear,format=nv12");
        config.video.output_height = None;
        let plan = SessionPlan { config: &config, caps: &caps, encoder: &e, gpu_path: true, session_dir: &dir, audio_tracks: &[] };
        assert_eq!(video_filter(&plan), None, "native size NVENC is zero-copy");
    }

    #[test]
    fn audio_tracks_are_mapped_in_order() {
        let mut config = CaptureConfig::default();
        config.video.source = VideoSource::TestPattern;
        let caps = caps(false);
        let e = enc(EncoderKind::Software, "libx264", false);
        let dir = PathBuf::from("buf");
        let tracks = [(TrackKind::Mixed, 4000), (TrackKind::System, 4001), (TrackKind::Microphone, 4002)];
        let plan = SessionPlan { config: &config, caps: &caps, encoder: &e, gpu_path: false, session_dir: &dir, audio_tracks: &tracks };
        let joined = build_args(&plan).join(" ");
        assert!(joined.contains("-re -f lavfi -i testsrc2=size=1920x1080:rate=60"));
        assert!(joined.contains("-i tcp://127.0.0.1:4002"));
        assert!(joined.contains("-map 0:v:0 -map 1:a:0 -map 2:a:0 -map 3:a:0"));
        assert!(joined.contains("-metadata:s:a:2 title=Microphone"));
        assert!(joined.contains("-vf format=yuv420p"));
    }

    #[test]
    #[cfg(windows)]
    fn window_capture_uses_gfxcapture() {
        let mut config = CaptureConfig::default();
        config.video.source = VideoSource::Window { hwnd: 1234 };
        config.video.capture_cursor = true;
        let input = video_input(&config, &caps(true)).join(" ");
        assert!(input.contains("gfxcapture=hwnd=1234:max_framerate=60:capture_cursor=1"));
    }
}
