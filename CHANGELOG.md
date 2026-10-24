# Changelog

## 0.2.0 — Capture studio (preview)

- Desktop/game source controls on Home, Record and Recording Settings; selected
  display applies to both Instant Replay and manual recording.
- Performance, Balanced and High quality presets with approximate storage use.
- Quick saves for the last 5/15/30 seconds and 1/2 minutes when the configured
  buffer is long enough; unavailable footage cannot be requested from these buttons.
- Active source in capture status and recording health; desktop fallback is visible.
- Desktop clips are filed under Desktop instead of inheriting a running game's name.
- Source and quality controls lock during recording and clip export.
- Shared, tested timeline range planning for future match timeline/editing features;
  this does not enable automatic Deadlock highlights or Full Match Recording yet.

Installer, GPU/audio behavior and real display numbering still require hardware QA.

## Unreleased — 0.1.0

First development milestone. See `docs/verification.md` for what has and has not been
tested on real hardware.

- Recording engine with Instant Replay ring buffer, manual recording, pause/resume,
  crash recovery, hardware encoder detection with fallbacks, WASAPI audio mixing
- Desktop app: library, clip editor, settings, hotkeys, tray, game detection
- Self-hostable server: accounts, resumable uploads, transcoding worker, media delivery
- Public clip pages with link-preview metadata; direct MP4 links
