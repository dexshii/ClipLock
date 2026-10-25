# Changelog

## 0.4.1 — Responsiveness fix (preview)

- Fixed the window freezing ("Not Responding") while the encoder starts or restarts:
  recorder, library and account calls no longer run on the UI thread.
- Release builds find BtbN's FFmpeg downloads again after its asset names changed.

## 0.4.0 — Smooth clips and running-app capture (preview)

- Fixed a hitch every second in saved clips and recordings: segments are now joined
  with their exact durations, removing the 10–20 ms video gaps and audio dropouts
  at each segment boundary. Engine tests fail on any frame gap.
- Instant Replay acknowledges the hotkey immediately (sound and "Saving clip…"),
  waits at most one segment for the current moment, and generates the thumbnail
  in the background so the clip appears in the library sooner.
- The capture target picker lists only what is running — detected games first,
  then open application windows — instead of the whole game database. Picking an
  app names clips after it and, in game-window mode, captures that window.
- Auto-detection finds the window of a game running in the background.

## 0.3.0 — Desktop workspace (preview)

- Rebuilt Home as a media workspace: recent captures first, with a compact recorder
  inspector and an effective-source/audio/format status strip.
- Moved replay saves and recording actions above source/quality configuration so
  primary capture actions remain easy to reach.
- Simplified source controls and quality selection; reduced card chrome, corner
  radii and accent use across the desktop application.
- Refined navigation, library thumbnails and metadata, filters, list density,
  recording view and settings spacing. Narrow list views scroll horizontally.
- Home loads recent captures independently of library filters and handles empty,
  favorites, loading and error states explicitly.
- Preserved manual recording, replay durations, quality profiles and source selection;
  replay saves remain available during manual recording.
- Added reduced-motion styling and kept the public web player's theme unchanged.

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
