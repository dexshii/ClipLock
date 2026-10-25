//! File-level media operations: joining segments into clips, probing, thumbnails and
//! the quick editor's export.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::EncoderKind;
use crate::error::{CaptureError, Result};
use crate::ffmpeg::{run_with_timeout, EncoderInfo, Ffmpeg};
use crate::segments::Segment;

/// Escapes a path for an ffconcat `file` directive (single-quoted; `'` → `'\''`).
fn concat_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

fn part_path(out: &Path) -> PathBuf {
    let mut name = out
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".part");
    out.with_file_name(name)
}

fn ffmpeg_failed(context: &str, stderr: &str) -> CaptureError {
    let tail: Vec<&str> = stderr.lines().rev().take(5).collect();
    CaptureError::Ffmpeg(format!(
        "{context}: {}",
        tail.into_iter().rev().collect::<Vec<_>>().join(" | ")
    ))
}

/// ffconcat script for `segments`. Each segment's exact duration (from the segmenter's
/// list) is written out: without it FFmpeg estimates durations from the MPEG-TS
/// timestamps, which are off by a frame or two, leaving a small timestamp gap — a
/// visible hitch and an audio dropout — at every segment boundary. The last segment
/// needs no duration (nothing follows it, and a recovered segment's is only estimated).
fn concat_list(segments: &[Segment]) -> String {
    let mut list = String::from("ffconcat version 1.0\n");
    for (i, s) in segments.iter().enumerate() {
        list.push_str(&format!("file {}\n", concat_quote(&s.path)));
        if i + 1 < segments.len() && s.duration() > 0.0 {
            list.push_str(&format!("duration {:.6}\n", s.duration()));
        }
    }
    list
}

/// Losslessly joins keyframe-aligned segments into an MP4 with the index at the front
/// (fast start). `max_duration` cuts the tail, which is safe without re-encoding.
pub fn concat_segments(
    ffmpeg: &Ffmpeg,
    segments: &[Segment],
    out: &Path,
    max_duration: Option<f64>,
) -> Result<()> {
    if segments.is_empty() {
        return Err(CaptureError::NothingBuffered);
    }
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let list_path = out.with_file_name(format!(
        ".{}.ffconcat",
        out.file_stem().and_then(|s| s.to_str()).unwrap_or("clip")
    ));
    std::fs::write(&list_path, concat_list(segments))?;

    let tmp = part_path(out);
    let mut cmd = ffmpeg.command();
    cmd.args([
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
    ])
    .arg(&list_path)
    .args([
        "-map",
        "0:v",
        "-map",
        "0:a?",
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
    ]);
    if let Some(d) = max_duration {
        cmd.args(["-t", &format!("{d:.3}")]);
    }
    cmd.args(["-movflags", "+faststart", "-f", "mp4"]).arg(&tmp);
    let result = run_with_timeout(&mut cmd, Duration::from_secs(600));
    let _ = std::fs::remove_file(&list_path);
    let output = result?;
    if !output.success {
        let _ = std::fs::remove_file(&tmp);
        return Err(ffmpeg_failed("joining segments failed", &output.stderr));
    }
    std::fs::rename(&tmp, out)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration_secs: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub video_codec: String,
    pub audio_tracks: u32,
    pub size_bytes: u64,
}

#[derive(Deserialize)]
struct ProbeOutput {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}
#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
}
#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

fn parse_rate(r: &str) -> f64 {
    match r.split_once('/') {
        Some((n, d)) => {
            let (n, d): (f64, f64) = (n.parse().unwrap_or(0.0), d.parse().unwrap_or(0.0));
            if d > 0.0 {
                n / d
            } else {
                0.0
            }
        }
        None => r.parse().unwrap_or(0.0),
    }
}

pub fn probe(ffmpeg: &Ffmpeg, path: &Path) -> Result<MediaInfo> {
    let mut cmd = ffmpeg.probe_command();
    cmd.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ])
    .arg(path);
    let out = run_with_timeout(&mut cmd, Duration::from_secs(30))?;
    if !out.success {
        return Err(ffmpeg_failed("probing failed", &out.stderr));
    }
    let parsed: ProbeOutput = serde_json::from_str(&out.stdout)?;
    let video = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| CaptureError::Ffmpeg("file has no video stream".into()))?;
    let duration = parsed
        .format
        .as_ref()
        .and_then(|f| f.duration.as_deref())
        .or(video.duration.as_deref())
        .and_then(|d| d.parse().ok())
        .unwrap_or(0.0);
    Ok(MediaInfo {
        duration_secs: duration,
        width: video.width.unwrap_or(0),
        height: video.height.unwrap_or(0),
        fps: video
            .avg_frame_rate
            .as_deref()
            .map(parse_rate)
            .unwrap_or(0.0),
        video_codec: video.codec_name.clone().unwrap_or_default(),
        audio_tracks: parsed
            .streams
            .iter()
            .filter(|s| s.codec_type.as_deref() == Some("audio"))
            .count() as u32,
        size_bytes: std::fs::metadata(path)?.len(),
    })
}

/// Writes a JPEG thumbnail taken at `at_secs` (clamped into the clip).
pub fn thumbnail(
    ffmpeg: &Ffmpeg,
    video: &Path,
    out: &Path,
    at_secs: f64,
    width: u32,
) -> Result<()> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = out.with_extension("part.jpg");
    let mut cmd = ffmpeg.command();
    cmd.args([
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-ss",
        &format!("{:.3}", at_secs.max(0.0)),
        "-i",
    ])
    .arg(video)
    .args([
        "-frames:v",
        "1",
        "-vf",
        &format!("scale={width}:-2"),
        "-q:v",
        "4",
        "-f",
        "image2",
    ])
    .arg(&tmp);
    let out_cmd = run_with_timeout(&mut cmd, Duration::from_secs(30))?;
    if !out_cmd.success || !tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
        return Err(ffmpeg_failed("thumbnail failed", &out_cmd.stderr));
    }
    std::fs::rename(&tmp, out)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSpec {
    pub input: PathBuf,
    pub output: PathBuf,
    pub trim_start_secs: f64,
    pub trim_end_secs: f64,
    /// 0.25 – 4.0
    pub speed: f64,
    pub mute: bool,
    /// Linear gain, 0.0 – 2.0
    pub volume: f64,
    /// Keyframe-accurate stream copy instead of re-encoding. Only valid when speed,
    /// volume and mute are unchanged.
    pub lossless: bool,
}

impl EditSpec {
    pub fn validate(&self) -> Result<()> {
        let bad = |m: &str| Err(CaptureError::InvalidConfig(m.to_string()));
        if !(self.trim_start_secs >= 0.0 && self.trim_end_secs > self.trim_start_secs + 0.05) {
            return bad("trim range is empty");
        }
        if !(0.25..=4.0).contains(&self.speed) {
            return bad("speed must be between 0.25x and 4x");
        }
        if !(0.0..=2.0).contains(&self.volume) {
            return bad("volume must be between 0% and 200%");
        }
        if self.lossless && (self.speed != 1.0 || self.volume != 1.0 || self.mute) {
            return bad("lossless export only supports trimming");
        }
        if self.input == self.output {
            return bad("export must not overwrite the original");
        }
        Ok(())
    }
}

/// `atempo` accepts 0.5–2.0 per instance in older FFmpeg builds; chain instances.
fn atempo_chain(speed: f64) -> String {
    let mut parts = Vec::new();
    let mut s = speed;
    while s > 2.0 {
        parts.push("atempo=2.0".to_string());
        s /= 2.0;
    }
    while s < 0.5 {
        parts.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    parts.push(format!("atempo={s:.6}"));
    parts.join(",")
}

/// Arguments for an edit export (without the leading ffmpeg path).
pub fn edit_args(
    spec: &EditSpec,
    encoder: Option<&EncoderInfo>,
    has_audio: bool,
    tmp_out: &Path,
) -> Vec<String> {
    let mut a: Vec<String> = [
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
    ]
    .map(String::from)
    .to_vec();
    let duration = spec.trim_end_secs - spec.trim_start_secs;
    // Both as input options: -t then limits the source range, not the (re-timed) output.
    a.extend([
        "-ss".into(),
        format!("{:.3}", spec.trim_start_secs),
        "-t".into(),
        format!("{duration:.3}"),
        "-i".into(),
    ]);
    a.push(spec.input.to_string_lossy().into_owned());
    a.extend(["-map".into(), "0:v:0".into()]);
    if has_audio && !spec.mute {
        a.extend(["-map".into(), "0:a:0".into()]);
    }
    if spec.lossless {
        a.extend([
            "-c".into(),
            "copy".into(),
            "-avoid_negative_ts".into(),
            "make_zero".into(),
        ]);
    } else {
        let mut vf = Vec::new();
        if spec.speed != 1.0 {
            vf.push(format!("setpts=PTS/{:.6}", spec.speed));
        }
        vf.push("format=yuv420p".into());
        a.extend(["-vf".into(), vf.join(",")]);
        match encoder {
            Some(e) if e.kind == EncoderKind::Nvenc => a.extend(
                [
                    "-c:v",
                    &e.ffmpeg_name,
                    "-preset",
                    "p5",
                    "-rc",
                    "vbr",
                    "-cq",
                    "21",
                    "-b:v",
                    "0",
                ]
                .map(String::from),
            ),
            Some(e) if e.kind == EncoderKind::Amf => a.extend(
                [
                    "-c:v",
                    &e.ffmpeg_name,
                    "-quality",
                    "quality",
                    "-rc",
                    "cqp",
                    "-qp_i",
                    "20",
                    "-qp_p",
                    "22",
                ]
                .map(String::from),
            ),
            Some(e) if e.kind == EncoderKind::Qsv => a.extend(
                [
                    "-c:v",
                    &e.ffmpeg_name,
                    "-preset",
                    "medium",
                    "-global_quality",
                    "22",
                ]
                .map(String::from),
            ),
            Some(e) if e.ffmpeg_name != "libx264" => a.extend([
                "-c:v".to_string(),
                e.ffmpeg_name.clone(),
                "-b:v".into(),
                "12M".into(),
            ]),
            _ => a.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "20"].map(String::from)),
        }
        if has_audio && !spec.mute {
            let mut af = Vec::new();
            if spec.speed != 1.0 {
                af.push(atempo_chain(spec.speed));
            }
            if spec.volume != 1.0 {
                af.push(format!("volume={:.3}", spec.volume));
            }
            if !af.is_empty() {
                a.extend(["-af".into(), af.join(",")]);
            }
            a.extend(["-c:a", "aac", "-b:a", "192k"].map(String::from));
        }
    }
    a.extend(["-movflags", "+faststart", "-f", "mp4"].map(String::from));
    a.push(tmp_out.to_string_lossy().into_owned());
    a
}

/// Exports an edited copy. The original file is never modified. `encoders` are the H.264
/// encoders to try, best first (the next one is used if one fails, e.g. a hardware
/// encoder rejecting unusual input); they are ignored for lossless exports.
/// `on_progress` receives values in 0.0–1.0.
pub fn export_edit(
    ffmpeg: &Ffmpeg,
    spec: &EditSpec,
    encoders: &[EncoderInfo],
    mut on_progress: impl FnMut(f64),
) -> Result<MediaInfo> {
    spec.validate()?;
    let info = probe(ffmpeg, &spec.input)?;
    if let Some(parent) = spec.output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if spec.lossless {
        return export_attempt(ffmpeg, spec, None, &info, &mut on_progress);
    }
    if encoders.is_empty() {
        return Err(CaptureError::NoEncoder);
    }
    let mut last = CaptureError::NoEncoder;
    for (i, encoder) in encoders.iter().enumerate() {
        match export_attempt(ffmpeg, spec, Some(encoder), &info, &mut on_progress) {
            Ok(out) => return Ok(out),
            Err(e) => {
                if i + 1 < encoders.len() {
                    tracing::warn!(
                        "export with {} failed ({e}); trying {}",
                        encoder.ffmpeg_name,
                        encoders[i + 1].ffmpeg_name
                    );
                }
                last = e;
            }
        }
    }
    Err(last)
}

fn export_attempt(
    ffmpeg: &Ffmpeg,
    spec: &EditSpec,
    encoder: Option<&EncoderInfo>,
    info: &MediaInfo,
    on_progress: &mut impl FnMut(f64),
) -> Result<MediaInfo> {
    let tmp = part_path(&spec.output);
    let args = edit_args(spec, encoder, info.audio_tracks > 0, &tmp);
    let output_duration =
        (spec.trim_end_secs.min(info.duration_secs) - spec.trim_start_secs) / spec.speed;

    let mut cmd = ffmpeg.command();
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stderr = child.stderr.take().expect("piped");
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut BufReader::new(stderr), &mut s);
        s
    });
    let stdout = child.stdout.take().expect("piped");
    for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
        if let Some(v) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = v.trim().parse::<f64>() {
                if output_duration > 0.0 {
                    on_progress((us / 1e6 / output_duration).clamp(0.0, 1.0));
                }
            }
        }
    }
    let status = child.wait()?;
    let stderr = err_thread.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(ffmpeg_failed("export failed", &stderr));
    }
    std::fs::rename(&tmp, &spec.output)?;
    on_progress(1.0);
    probe(ffmpeg, &spec.output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_concat_paths() {
        assert_eq!(concat_quote(Path::new("/a/it's.ts")), r"'/a/it'\''s.ts'");
        assert_eq!(
            concat_quote(Path::new(r"C:\Clips\a.ts")),
            r"'C:\Clips\a.ts'"
        );
    }

    #[test]
    fn concat_list_carries_exact_durations() {
        let seg = |i: u64, start: f64, end: f64| Segment {
            index: i,
            path: PathBuf::from(format!("/b/seg_{i}.ts")),
            start,
            end,
        };
        let list = concat_list(&[
            seg(1, 1.023222, 2.023222),
            seg(2, 2.023222, 3.04),
            seg(3, 3.04, 4.0),
        ]);
        assert_eq!(
            list,
            "ffconcat version 1.0\nfile '/b/seg_1.ts'\nduration 1.000000\nfile '/b/seg_2.ts'\nduration 1.016778\nfile '/b/seg_3.ts'\n"
        );
    }

    #[test]
    fn atempo_chains_out_of_range_speeds() {
        assert_eq!(atempo_chain(1.5), "atempo=1.500000");
        assert_eq!(atempo_chain(4.0), "atempo=2.0,atempo=2.000000");
        assert_eq!(atempo_chain(0.25), "atempo=0.5,atempo=0.500000");
    }

    #[test]
    fn edit_validation() {
        let mut s = EditSpec {
            input: "in.mp4".into(),
            output: "out.mp4".into(),
            trim_start_secs: 1.0,
            trim_end_secs: 5.0,
            speed: 1.0,
            mute: false,
            volume: 1.0,
            lossless: true,
        };
        s.validate().unwrap();
        s.speed = 2.0;
        assert!(s.validate().is_err());
        s.lossless = false;
        s.validate().unwrap();
        s.output = s.input.clone();
        assert!(s.validate().is_err());
    }

    #[test]
    fn edit_args_apply_filters() {
        let spec = EditSpec {
            input: "in.mp4".into(),
            output: "out.mp4".into(),
            trim_start_secs: 2.0,
            trim_end_secs: 6.0,
            speed: 2.0,
            mute: false,
            volume: 0.5,
            lossless: false,
        };
        let a = edit_args(&spec, None, true, Path::new("out.mp4.part")).join(" ");
        assert!(a.contains("-ss 2.000 -t 4.000 -i in.mp4"));
        assert!(a.contains("-vf setpts=PTS/2.000000,format=yuv420p"));
        assert!(a.contains("-af atempo=2.000000,volume=0.500"));
        assert!(a.contains("-c:v libx264"));
        let muted = EditSpec { mute: true, ..spec };
        let a = edit_args(&muted, None, true, Path::new("o")).join(" ");
        assert!(!a.contains("0:a:0"));
        assert!(!a.contains("-c:a"));
    }
}
