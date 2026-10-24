# ClipLock: integrated product architecture and implementation plan

## Baseline audit

The repository already contains a Tauri 2 / React Windows desktop app, Rust/FFmpeg
GPU capture engine, SQLite library, non-destructive single-clip trim/export,
Fastify API, transcoding worker, Next.js sharing pages and Docker self-hosting.
Preserve these components. GPU capture, WASAPI and installed-app behavior still need
real Windows hardware verification per verification.md. Discord inline playback
is implemented as metadata/media delivery infrastructure but remains unverified.

Deadlock currently appears in the game-process detection catalog only. Process
detection is not kill/assist detection. No match-session lifecycle, event-driven
highlight capture, full-match product mode, match timeline or montage export was
found during the source audit. The existing editor timeline edits one clip.

## One recording, multiple views

Keep the existing capture engine as the sole encoder owner. Instant Replay is a
rolling retention policy. Full Match Recording is a match-scoped retention policy
pinning the entire match, with interruption recovery and disk-budget checks.
Manual recording remains available. Full-match and manual consumers must have
independent pin ownership; stopping one must not release another's media.

Persist match sessions, recording assets, markers and clip range references in
desktop SQLite using additive migrations. Give every marker a stable event ID,
match ID, source and recording-media offset. Use media offsets for editing; map
game time to this clock explicitly, including pauses and encoder restarts. Model
restart gaps as separate source assets rather than silently compressing time.

A Deadlock adapter produces normalized kill, assist, multi-kill and Mid Boss
events. First validate an available, permitted event source and its clock/identity
semantics; do not assume a live game API exists. Keep replay/demo imports distinct
from live events. Provider failure must leave manual capture usable. Deduplicate
provider events and group player kills with a configurable multi-kill window.

The highlight scheduler requests pre/post event windows, waits until post-roll
media is available and pins inputs until export finishes. Match Timeline shows
automatic and manual markers over the same source. Clips are non-destructive edit
decisions referencing retained media. Extension is limited by retained source;
expired replay media cannot be recreated. Merge overlapping ranges; concatenate
disjoint ranges as ordered montage items without inserting unwanted gameplay.

Export through the existing FFmpeg media layer, then register the resulting file
in the existing library and optional upload queue. Keep sharing opt-in. Reuse the
self-hostable API/worker/web flow for Discord-compatible H.264/AAC fast-start MP4,
HTTPS, byte ranges and public/unlisted share pages. Verify actual Discord inline
playback before claiming compatibility. Full match recordings stay local unless
explicitly selected for upload. No cloud dependency for recording or editing.

## Incremental delivery and acceptance

Capture studio preview (0.2.0) adds visible desktop/game capture controls, quality
presets, quick-save durations and actual source indicators. Existing game-window
capture may fall back to the selected display when no game window is available;
this is now visible. A future game-only policy should wait for a game rather than
capture a fallback display, and retain the selected game's HWND while unfocused.
Display numbers follow capture-device output indices; physical Windows display
numbering and mixed-GPU monitor layouts need hardware validation.

1. **Domain foundation (this change):** shared validated marker/source/clip ranges;
   event context planning, retained-media bounds, resize and merge/montage planning.
   Unit tests cover boundaries, stale media, foreign sessions and overlapping clips.
   These utilities are not yet wired into desktop commands or UI.
2. **Durable match sessions:** additive SQLite migrations and Rust commands for
   start/stop/recover match, independent retention pins and storage limits. Prove
   replay + manual + full match coexist and survive interruption without data loss.
3. **Match Timeline:** match list/detail route, manual bookmarks, source playback,
   marker seeking and range editor. Persist edit decisions and export through the
   existing library. Verify extend/trim/merge with actual source files.
4. **Deadlock adapter:** establish event source with recorded fixtures, clock mapping,
   deduplication and local-player filtering; connect post-roll scheduling. Verify
   kill, assist, multi-kill and Mid Boss against real matches before enabling them.
5. **Sharing and release:** verify Discord playback on a public self-host deployment;
   exercise GPU vendors, audio, long matches, disk exhaustion, installer and crash
   recovery. Update user-facing feature claims only after these checks pass.

The target remains an open-source Windows Medal.tv alternative with a modern UI,
GPU Instant Replay/manual capture, automatic Deadlock clips, Full Match Recording,
Match Timeline, extensible/trimmed/merged clips and Discord-viewable share links.
