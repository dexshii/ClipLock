//! Tracking of the encoder's segment files.
//!
//! FFmpeg's segment muxer appends one CSV line (`file,start,end`) to the segment list
//! each time it closes a segment. Every segment starts on a keyframe, so any contiguous
//! run of segments can be concatenated losslessly. The replay buffer is the set of
//! segments still on disk; old ones are pruned unless pinned by an active recording or
//! an in-flight export.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub index: u64,
    pub path: PathBuf,
    /// Start/end on the session timeline, in seconds.
    pub start: f64,
    pub end: f64,
}

impl Segment {
    pub fn duration(&self) -> f64 {
        (self.end - self.start).max(0.0)
    }
}

pub const SEGMENT_PREFIX: &str = "seg_";
pub const SEGMENT_EXT: &str = "ts";
pub const SEGMENT_LIST: &str = "segments.csv";

/// The FFmpeg output pattern for segment files inside `dir`.
pub fn segment_pattern(dir: &Path) -> PathBuf {
    dir.join(format!("{SEGMENT_PREFIX}%06d.{SEGMENT_EXT}"))
}

pub fn segment_index_from_name(name: &str) -> Option<u64> {
    name.strip_prefix(SEGMENT_PREFIX)?
        .strip_suffix(&format!(".{SEGMENT_EXT}"))?
        .parse()
        .ok()
}

pub fn parse_list_line(dir: &Path, line: &str) -> Option<Segment> {
    let mut parts = line.trim().rsplitn(3, ',');
    let end: f64 = parts.next()?.trim().parse().ok()?;
    let start: f64 = parts.next()?.trim().parse().ok()?;
    let file = parts.next()?.trim().trim_matches('"');
    let name = Path::new(file).file_name()?.to_str()?;
    let index = segment_index_from_name(name)?;
    if !(start.is_finite() && end.is_finite()) || end < start {
        return None;
    }
    Some(Segment {
        index,
        path: dir.join(name),
        start,
        end,
    })
}

/// Incrementally reads a live segment list.
#[derive(Debug)]
pub struct SegmentLog {
    dir: PathBuf,
    offset: u64,
    partial: String,
    segments: VecDeque<Segment>,
}

impl SegmentLog {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            offset: 0,
            partial: String::new(),
            segments: VecDeque::new(),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Reads any lines appended since the last call. Returns how many segments were added.
    pub fn poll(&mut self) -> std::io::Result<usize> {
        let path = self.dir.join(SEGMENT_LIST);
        let mut file = match File::open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e),
        };
        let len = file.metadata()?.len();
        if len < self.offset {
            // The list was rewritten; FFmpeg only does that without `+live`. Start over.
            self.offset = 0;
            self.partial.clear();
            self.segments.clear();
        }
        if len == self.offset {
            return Ok(0);
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut buf = String::new();
        file.read_to_string(&mut buf)?;
        self.offset += buf.len() as u64;
        self.partial.push_str(&buf);

        let mut added = 0;
        while let Some(nl) = self.partial.find('\n') {
            let line: String = self.partial.drain(..=nl).collect();
            if let Some(seg) = parse_list_line(&self.dir, &line) {
                if self
                    .segments
                    .back()
                    .is_none_or(|last| seg.index > last.index)
                {
                    self.segments.push_back(seg);
                    added += 1;
                }
            }
        }
        Ok(added)
    }

    pub fn segments(&self) -> &VecDeque<Segment> {
        &self.segments
    }

    /// End of the newest completed segment on the session timeline.
    pub fn buffered_until(&self) -> Option<f64> {
        self.segments.back().map(|s| s.end)
    }

    /// Seconds of footage currently held.
    pub fn buffered_seconds(&self) -> f64 {
        match (self.segments.front(), self.segments.back()) {
            (Some(first), Some(last)) => last.end - first.start,
            _ => 0.0,
        }
    }

    /// Removes segments that ended before `keep_after` and whose index is below
    /// `pinned_from` (if any). Returns the removed segments so the caller can delete
    /// the files.
    pub fn prune(&mut self, keep_after: f64, pinned_from: Option<u64>) -> Vec<Segment> {
        let mut removed = Vec::new();
        while let Some(front) = self.segments.front() {
            let expired = front.end <= keep_after;
            let pinned = pinned_from.is_some_and(|p| front.index >= p);
            // Never remove the newest segment: it anchors `buffered_until`.
            if !expired || pinned || self.segments.len() == 1 {
                break;
            }
            removed.push(self.segments.pop_front().expect("front exists"));
        }
        removed
    }
}

/// Selects the segments for an instant replay that ends at `until` and should last
/// `seconds`: every segment overlapping `[until - seconds, until)`. Because segments
/// start on keyframes the actual start snaps back to the closest segment boundary.
pub fn select_replay(segments: &VecDeque<Segment>, until: f64, seconds: f64) -> Vec<Segment> {
    let from = until - seconds;
    segments
        .iter()
        .filter(|s| s.end > from + 1e-3 && s.start < until - 1e-3)
        .cloned()
        .collect()
}

/// Selects segments for a manual recording from `start` to `stop` (session timeline)
/// with the given pauses. A segment is kept when at least half of it falls inside the
/// recorded (unpaused) time, so every cut lands within half a segment of the request.
pub fn select_recording(
    segments: impl IntoIterator<Item = Segment>,
    start: f64,
    stop: Option<f64>,
    pauses: &[(f64, Option<f64>)],
) -> Vec<Segment> {
    let stop = stop.unwrap_or(f64::INFINITY);
    segments
        .into_iter()
        .filter(|s| {
            let overlap = |a: f64, b: f64| (s.end.min(b) - s.start.max(a)).max(0.0);
            let recorded = overlap(start, stop)
                - pauses
                    .iter()
                    .map(|(ps, pe)| overlap(ps.max(start), pe.unwrap_or(f64::INFINITY).min(stop)))
                    .sum::<f64>();
            s.duration() > 0.0 && recorded >= s.duration() / 2.0 - 1e-6
        })
        .collect()
}

/// When `stop` falls inside the last selected segment, the clip length that ends
/// exactly at `stop` (cutting the tail needs no re-encode).
pub fn trimmed_duration(selected: &[Segment], stop: Option<f64>) -> Option<f64> {
    let last = selected.last()?;
    let stop = stop?;
    (stop > last.start && stop < last.end).then(|| {
        let total: f64 = selected.iter().map(Segment::duration).sum();
        total - (last.end - stop)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn seg(i: u64, start: f64, end: f64) -> Segment {
        Segment {
            index: i,
            path: PathBuf::from(format!("seg_{i:06}.ts")),
            start,
            end,
        }
    }

    #[test]
    fn parses_csv_lines() {
        let dir = Path::new("/tmp/x");
        let s = parse_list_line(dir, "seg_000012.ts,24.000000,26.016000\n").unwrap();
        assert_eq!(s.index, 12);
        assert_eq!(s.path, dir.join("seg_000012.ts"));
        assert!((s.duration() - 2.016).abs() < 1e-9);
        let s = parse_list_line(dir, "C:\\buf\\seg_000003.ts,6.0,8.0").unwrap_or_else(|| {
            // Windows paths only parse as file names on Windows; accept the bare form elsewhere.
            parse_list_line(dir, "seg_000003.ts,6.0,8.0").unwrap()
        });
        assert_eq!(s.index, 3);
        assert!(parse_list_line(dir, "garbage").is_none());
        assert!(parse_list_line(dir, "seg_000001.ts,5,4").is_none());
    }

    #[test]
    fn reads_list_incrementally_and_handles_partial_lines() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = SegmentLog::new(dir.path());
        assert_eq!(log.poll().unwrap(), 0);
        let mut f = std::fs::File::create(dir.path().join(SEGMENT_LIST)).unwrap();
        write!(f, "seg_000000.ts,0.0,1.0\nseg_000001.ts,1.0,2.0\nseg_0000").unwrap();
        f.flush().unwrap();
        assert_eq!(log.poll().unwrap(), 2);
        writeln!(f, "02.ts,2.0,3.0").unwrap();
        f.flush().unwrap();
        assert_eq!(log.poll().unwrap(), 1);
        assert_eq!(log.segments().len(), 3);
        assert_eq!(log.buffered_until(), Some(3.0));
        assert_eq!(log.buffered_seconds(), 3.0);
    }

    #[test]
    fn prune_respects_window_and_pins() {
        let mut log = SegmentLog::new("/tmp");
        for i in 0..10 {
            log.segments.push_back(seg(i, i as f64, i as f64 + 1.0));
        }
        let removed = log.prune(4.0, None);
        assert_eq!(
            removed.iter().map(|s| s.index).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
        let removed = log.prune(8.0, Some(5));
        assert_eq!(removed.iter().map(|s| s.index).collect::<Vec<_>>(), vec![4]);
        let removed = log.prune(100.0, None);
        assert_eq!(removed.len(), 4, "newest segment is always kept");
        assert_eq!(log.segments().len(), 1);
    }

    #[test]
    fn replay_selection_covers_window() {
        let segs: VecDeque<_> = (0..10)
            .map(|i| seg(i, i as f64 * 2.0, i as f64 * 2.0 + 2.0))
            .collect();
        let picked = select_replay(&segs, 15.0, 5.0);
        assert_eq!(
            picked.iter().map(|s| s.index).collect::<Vec<_>>(),
            vec![5, 6, 7]
        );
        let picked = select_replay(&segs, 20.0, 1000.0);
        assert_eq!(picked.len(), 10);
    }

    #[test]
    fn recording_selection_skips_paused_segments() {
        let segs: Vec<_> = (0..10).map(|i| seg(i, i as f64, i as f64 + 1.0)).collect();
        let ids = |v: Vec<Segment>| v.iter().map(|s| s.index).collect::<Vec<_>>();
        // Half-covered segments at the edges are kept; pause covers 4.0–6.0 exactly.
        let picked = select_recording(segs.clone(), 2.5, Some(8.5), &[(4.0, Some(6.0))]);
        assert_eq!(ids(picked), vec![2, 3, 6, 7, 8]);
        // Less than half covered at the edges: dropped. Pause 4.6–6.3 removes 5 only.
        let picked = select_recording(segs.clone(), 2.6, Some(8.4), &[(4.6, Some(6.3))]);
        assert_eq!(ids(picked), vec![3, 4, 6, 7]);
        // An open pause runs until the stop.
        let picked = select_recording(segs.clone(), 2.5, None, &[(7.0, None)]);
        assert_eq!(ids(picked), vec![2, 3, 4, 5, 6]);
        let picked = select_recording(segs, 2.0, Some(5.7), &[]);
        assert_eq!(
            trimmed_duration(&picked, Some(5.7)).map(|d| (d * 10.0).round() / 10.0),
            Some(3.7)
        );
    }
}
