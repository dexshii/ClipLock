//! Small helpers: safe file names and unique output paths.

use std::path::{Path, PathBuf};

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Turns arbitrary text (game names, user titles) into a safe single path component on
/// Windows and Unix: no separators, no `..`, no reserved device names, bounded length.
pub fn sanitize_file_name(input: &str, fallback: &str) -> String {
    let mut out: String = input
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    out = out.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    if out.chars().count() > 100 {
        out = out
            .chars()
            .take(100)
            .collect::<String>()
            .trim_end()
            .to_string();
    }
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    if out.is_empty() || RESERVED.contains(&stem.as_str()) {
        return fallback.to_string();
    }
    out
}

/// Returns `dir/name.ext`, or `dir/name (2).ext`, ... if that already exists.
pub fn unique_path(dir: &Path, name: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{name}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|i| dir.join(format!("{name} ({i}).{ext}")))
        .find(|p| !p.exists())
        .expect("infinite iterator")
}

/// Checks that `path` is inside `root` after resolving `..` and symlinks.
pub fn is_within(root: &Path, path: &Path) -> bool {
    match (root.canonicalize(), path.canonicalize()) {
        (Ok(root), Ok(path)) => path.starts_with(root),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_names() {
        assert_eq!(
            sanitize_file_name("Counter-Strike 2", "x"),
            "Counter-Strike 2"
        );
        assert_eq!(sanitize_file_name("../../etc/passwd", "x"), "etc passwd");
        assert_eq!(
            sanitize_file_name("a:b*c?d\"e<f>g|h", "x"),
            "a b c d e f g h"
        );
        assert_eq!(sanitize_file_name("CON", "Clip"), "Clip");
        assert_eq!(sanitize_file_name("nul.txt", "Clip"), "Clip");
        assert_eq!(sanitize_file_name("  ...  ", "Clip"), "Clip");
        assert_eq!(
            sanitize_file_name("tab\there\nnewline", "x"),
            "tab here newline"
        );
        assert_eq!(sanitize_file_name(&"x".repeat(300), "x").len(), 100);
    }

    #[test]
    fn unique_paths_do_not_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let a = unique_path(dir.path(), "clip", "mp4");
        std::fs::write(&a, b"").unwrap();
        let b = unique_path(dir.path(), "clip", "mp4");
        assert_eq!(b.file_name().unwrap(), "clip (2).mp4");
    }

    #[test]
    fn detects_escape_from_root() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("a");
        std::fs::create_dir(&inner).unwrap();
        assert!(is_within(dir.path(), &inner));
        assert!(!is_within(&inner, &inner.join("..")));
    }
}
