# Verification status

What has actually been exercised, and how. Anything not listed as verified should be
treated as unverified.

Legend: ✅ verified by automated tests or a recorded manual run · 🟡 partially verified · ⛔ not verified

## Recording engine

| Capability | Status | Evidence |
| --- | --- | --- |
| Segment ring buffer stays bounded | ✅ | `native/capture/tests/engine.rs` (Linux CI and Windows CI) |
| Save last N seconds; duration, fast start, 3 audio tracks, A/V drift < 0.35 s | ✅ | same test, also on Windows runner with the bundled LGPL FFmpeg (Media Foundation H.264) |
| Manual recording alongside replay; pause/resume cuts | ✅ | same test |
| Recording without replay cleans up its buffer | ✅ | same test |
| Crash recovery from a recording manifest | ✅ | same test |
| Edit export: trim, 2× speed, volume, lossless trim, thumbnail | ✅ | `edit_export_trims_and_changes_speed` |
| Encoder discovery by test encode, fallback order | ✅ | unit tests + Windows CI `probe` output |
| Desktop Duplication (`ddagrab`) capture on a real desktop | ⛔ | CI runners have no interactive desktop; the CI smoke step is informational |
| Windows.Graphics.Capture window capture (`gfxcapture`) | ⛔ | depends on the bundled FFmpeg build exposing it; untested |
| NVENC / AMF / Quick Sync encoding and the zero-copy GPU path | ⛔ | no GPU available; FFmpeg arguments are unit-tested only |
| WASAPI loopback + microphone capture | ⛔ | compiles for Windows (CI clippy/tests); no audio devices in CI. The mixer is tested with synthetic sources |
| Recording overhead / FPS impact in games | ⛔ | no benchmark data yet; see `docs/performance.md` for the method |

## Desktop app

| Capability | Status | Evidence |
| --- | --- | --- |
| Builds on Windows; NSIS installer produced | 🟡 | Windows CI job builds the installer artifact; installing/uninstalling not yet tested by a person |
| Settings persistence, validation, backup recovery | ✅ | Rust unit tests |
| SQLite library (search, filters, sorting, favorites, upload state) | ✅ | Rust unit tests |
| Game database matching | ✅ | Rust unit tests; Windows foreground-window detection ⛔ |
| UI end to end on Linux (Xvfb): Instant Replay on, **Alt+F10 global hotkey** saves a clip, thumbnail, library, rename/favorite, editor trim + 2× export, settings | ✅ | manual run during development (x11grab source, software encoder) |
| Local video playback in the app | 🟡 | WebKitGTK (Linux) cannot play asset-protocol video; Windows WebView2 untested |
| System tray, close-to-tray, notifications, autostart, sound cues on Windows | ⛔ | implemented; untested on Windows |
| Signed updater | ⛔ | wired up; no signing key or release published yet |

## Cloud

| Capability | Status | Evidence |
| --- | --- | --- |
| Accounts: register/login, Argon2id, token rotation, **refresh-token reuse revokes the family**, logout, rate limiting, deletion | ✅ | `services/api/test/api.test.ts` (Postgres) |
| Resumable multipart upload via presigned URLs, duplicate prevention, size limits, cancel | ✅ | `services/worker/test/pipeline.test.ts` (Postgres + S3 emulator) |
| Worker transcode: H.264 High / yuv420p / AAC / fast start, 720p rendition, thumbnail, invalid input rejected | ✅ | same |
| Media endpoint: 200/206/416, HEAD Content-Length, ETag, private signed URLs, no access across accounts, purge | ✅ | same |
| Desktop → server: sign up, upload, processing, share link (real UI, local server) | ✅ | manual run during development |
| Credential persistence in Windows Credential Manager | ⛔ | Linux dev keyring is per-session |
| Docker images and docker-compose deployment | 🟡 | images built in CI; compose config validated; a full deployment with TLS not yet run |
| Real MinIO / AWS S3 / R2 | 🟡 | tests use an S3 emulator (moto); production providers untested |

## Sharing and Discord

| Capability | Status | Evidence |
| --- | --- | --- |
| Clip page metadata (OG video, Twitter player, oEmbed, noindex for unlisted) | ✅ | `apps/web/lib/clip-meta.test.ts`, live HTML inspected |
| Crawler view of a deployment | ✅ | `tests/discord/check-embed.mjs` passed against a local deployment |
| **Inline playback inside Discord** | ⛔ | **Not tested.** See `docs/discord.md` for the protocol. The feature is not complete until that table is filled in. |
