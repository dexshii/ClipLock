# Architecture

```
┌────────────────────────── Windows PC ──────────────────────────┐        ┌──────────────── Server (self-hostable) ────────────────┐
│ ClipLock desktop (Tauri 2)                                     │        │                                                         │
│  React UI ◄─ IPC ─► Rust core ──────────────┐                  │ HTTPS  │  Caddy ─┬─ /c/*, /embed/*, / ──► web (Next.js)          │
│                     │ settings.json         │ cloud client ────┼───────►│         ├─ /v1/*, /media/* ───► api (Fastify) ── Postgres│
│                     │ SQLite library        │ upload queue ────┼──┐     │         │                         │    ▲ jobs (SKIP LOCKED)│
│                     │ hotkeys, tray, games  │                  │  │PUT  │         │                         ▼    │                   │
│                     ▼                       │                  │  └────►│  S3-compatible storage ◄──────── worker (FFmpeg)        │
│  cliplock-capture (Rust)                    │                  │        └─────────────────────────────────────────────────────────┘
│   engine ─ segment ring buffer ─ exports    │                  │
│   WASAPI loopback + mic ─ mixer ─ TCP ─┐    │                  │
│                                        ▼    │                  │
│   ffmpeg.exe: ddagrab/gfxcapture → NVENC/AMF/QSV/MF → TS segments │
└────────────────────────────────────────────────────────────────┘
```

## Recording engine (`native/capture`)

**Why a separate FFmpeg process.** Capture and encoding are the performance-critical
path. FFmpeg already implements GPU capture (`ddagrab`: Desktop Duplication API;
`gfxcapture`: Windows.Graphics.Capture), GPU scaling/colour conversion (`scale_d3d11`)
and every Windows hardware encoder (NVENC, AMF, Quick Sync, Media Foundation). Frames go
from the capture API to the encoder as D3D11 textures without being copied to system
memory when the GPU path is available. Running it out of process isolates driver
crashes from the UI; a Windows job object kills it if ClipLock dies. The Rust engine
owns orchestration, which is the part that needs product logic.

**Segment ring buffer (Instant Replay).** The encoder writes MPEG-TS segments of one
second with a keyframe at each boundary (`-force_key_frames`), and appends each
finished segment to a CSV list. The engine reads that list, keeps the newest
`replay length + 1 segment` and deletes older files. Saving a replay waits for the
segment containing "now" to close, then concatenates the selected segments with
`-c copy` into an MP4 with fast start, cutting the tail exactly at the request time.
Nothing is encoded twice and saving a 5-minute replay takes about a second.

**Manual recording** pins segments from the moment recording starts, so a recording and
the replay buffer share one encoder. Pause/resume excludes segments that are mostly
paused (cuts are within half a segment). A JSON manifest is written while recording;
after a crash the next start finalizes it from the segments on disk.

**Audio.** WASAPI loopback (game/system audio) and microphone capture run on their own
threads with automatic conversion to 48 kHz stereo float. A mixer thread produces
samples on a wall-clock schedule — inserting silence when loopback is idle, dropping
samples if a device clock drifts fast — and streams raw PCM to FFmpeg over loopback
TCP (one stream per track: mixed, and optionally system and mic separately). Volumes
and mic mute are applied live.

**Fallbacks.** Encoders are discovered by test-encoding a few frames with each candidate
(an encoder being compiled into FFmpeg says nothing about the GPU). If the preferred
encoder fails to start the engine retries without the GPU path (e.g. capture and
encoder on different GPUs) and then walks down the list to software. A dying encoder
is restarted up to three times; an active recording is saved first.

## Desktop app (`apps/desktop`)

- **Rust core** (`src-tauri/src`): settings (JSON, atomic writes with backup), SQLite
  library with migrations, recorder service, global hotkeys, tray, game detection
  (foreground process + process list against `resources/games.json`), cloud client
  (refresh token in Windows Credential Manager), upload queue, signed updater.
- **UI**: React + Tailwind + Zustand. Every page talks to Rust through typed commands
  in `src/lib/ipc.ts`; backend state changes are pushed as events.
- **Local playback** uses Tauri's asset protocol, scoped to the clip and thumbnail
  folders.

## Server

- **API** (`services/api`, Fastify + Zod + OpenAPI at `/docs`): accounts with Argon2id
  passwords and opaque rotating tokens; clip metadata; presigned S3 multipart uploads;
  media delivery with byte ranges; public metadata for the website.
- **Worker** (`services/worker`): claims jobs from Postgres, validates uploads with
  ffprobe, transcodes to H.264 High/AAC fast-start MP4 (source ≤ 1440p plus 720p) and a
  thumbnail, then deletes the original. Uploaded files are never served as-is.
- **Web** (`apps/web`, Next.js): server-rendered clip pages with link-preview metadata,
  an embeddable player and oEmbed.

## Status lifecycle

Desktop clip status: `LOCAL → QUEUED → UPLOADING → PROCESSING → READY`, or `FAILED`
from any active state (retry resumes the multipart upload). The server only knows
`UPLOADING → PROCESSING → READY | FAILED`. Share links are shown as soon as a clip id
exists but only work once the clip is `READY`.

## Key trade-offs

| Decision | Why | Cost |
| --- | --- | --- |
| FFmpeg process instead of in-process capture code | Mature GPU capture + every HW encoder, crash isolation | ~80 MB sidecar; encoder features follow the bundled FFmpeg build |
| LGPL FFmpeg build | Redistributable next to MIT code | No x264; software fallback is Media Foundation/OpenH264 |
| 1 s TS segments | Precise replay starts and pause cuts | Many small files in the buffer folder |
| Postgres job queue | No Redis to operate | Polling (1 s) instead of push |
| Stream media through the API by default | Works with any storage, one origin, range support | Bandwidth through the API; `MEDIA_DELIVERY=redirect` + CDN for scale |
| Opaque tokens in the database | Instant revocation, reuse detection | One indexed lookup per request |
