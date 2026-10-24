# Self-hosting the ClipLock server

The server is optional: the desktop app records and manages clips without it. You need
it for accounts, uploads and share links. Nothing depends on a ClipLock-operated cloud.

## Requirements

- A Linux machine with Docker, ports 80/443 open
- Two DNS names pointing at it, e.g. `clips.example.com` (site, API, media) and
  `storage.clips.example.com` (direct uploads to MinIO). With external S3 storage you
  only need the first.
- CPU for transcoding: roughly real-time for 1080p60 per core-group with libx264 `fast`.
  Set `WORKER_VIDEO_ENCODER=h264_nvenc` on NVIDIA hosts (requires an FFmpeg with NVENC
  in the worker image).

## Deploy

```bash
git clone https://github.com/dexshii/ClipLock && cd ClipLock
cp infrastructure/.env.example infrastructure/.env     # set domains and secrets
docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env up -d --build
```

Caddy requests TLS certificates automatically. Then:

1. Open `https://clips.example.com` — the landing page should load.
2. `https://clips.example.com/v1/health` → `{"ok":true}`; API docs at `/docs`.
3. In the desktop app: Settings → Uploads → Server → `https://clips.example.com`, then
   create an account on the Account page.
4. Upload a clip and run `node tests/discord/check-embed.mjs https://clips.example.com/c/<id>`.

Set `ALLOW_REGISTRATION=false` after creating your accounts for a private instance.

## Configuration reference (API and worker)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Public origin used in share links |
| `CORS_ORIGINS` | `http://localhost:3000` | Browser origins allowed to call the API |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the API (client IPs for rate limits) |
| `MEDIA_SIGNING_SECRET` | — | ≥ 32 chars; signs private media URLs |
| `MEDIA_DELIVERY` | `proxy` | `proxy` streams via the API; `redirect` sends 302s to `MEDIA_CDN_BASE_URL` |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` | — | Storage endpoint, and the address clients use for presigned uploads |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | | Storage credentials (never sent to clients) |
| `ALLOW_REGISTRATION` | `true` | Open sign-ups |
| `MAX_UPLOAD_BYTES` | 4 GiB | Per-clip upload limit |
| `MAX_CLIP_DURATION_SECONDS` | 3600 | Longest accepted clip |
| `USER_STORAGE_QUOTA_BYTES` | 50 GiB | Per-account storage |
| `RATE_LIMIT_PER_MINUTE` | 300 | General per-IP limit (auth routes are stricter) |
| `WORKER_CONCURRENCY`, `WORKER_VIDEO_ENCODER`, `WORKER_KEEP_ORIGINALS` | 1, `libx264`, `false` | Worker tuning |

## Operations

- **Backups:** PostgreSQL (`pg_dump`) and the bucket. Media can be regenerated only if
  `WORKER_KEEP_ORIGINALS=true`.
- **Upgrades:** pull, rebuild, restart. Migrations run automatically and are serialized
  with an advisory lock.
- **Deleting data:** deleting a clip or an account removes database rows immediately and
  storage objects via background `purge-clip` jobs.
- **Abandoned uploads:** configure a bucket lifecycle rule to abort incomplete multipart
  uploads after a few days.
