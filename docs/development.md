# Development

## Prerequisites

- Node.js 22+ and pnpm 10 (`corepack enable`)
- Rust (the version in `rust-toolchain.toml` is installed automatically by rustup)
- FFmpeg + FFprobe
- For the desktop app on Windows: WebView2 (preinstalled on Windows 11) and the
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- For the server: PostgreSQL 16 and S3-compatible storage (Docker makes this easy)

## Layout

```
apps/desktop      Tauri 2 app (React UI in src/, Rust core in src-tauri/)
apps/web          Next.js public site (clip pages, embeds, oEmbed)
services/api      Fastify REST API (+ OpenAPI at /docs)
services/worker   FFmpeg transcoding worker
packages/shared   Zod schemas and helpers shared by every TypeScript package
packages/ui       Design tokens (Tailwind theme) and logo
native/capture    Rust recording engine + `cliplock-capture` CLI
infrastructure    Dockerfile, docker-compose, Caddyfile
tests/discord     Link-preview checker
docs              Architecture, Discord, self-hosting, releasing, verification
```

## First run

```bash
pnpm install
pnpm --filter @cliplock/shared build
node scripts/fetch-ffmpeg.mjs          # Windows: downloads the FFmpeg sidecars
pnpm dev:desktop                       # starts Vite + the Tauri app
```

On Linux/macOS you can develop the UI and engine without Windows: symlink your
system FFmpeg as the sidecars, and set `CLIPLOCK_SYNTHETIC_AUDIO=1` (no WASAPI).
Monitor capture uses `x11grab` on Linux as a development convenience.

```bash
for b in ffmpeg ffprobe; do ln -sf "$(which $b)" "apps/desktop/src-tauri/binaries/$b-$(rustc -vV | sed -n 's/host: //p')"; done
```

## Local server

```bash
docker compose -f infrastructure/docker-compose.dev.yml up -d   # Postgres + MinIO (+ bucket)
cp .env.example .env
pnpm --filter @cliplock/api build
pnpm dev:api        # http://localhost:8080 (migrations run on start; docs at /docs)
pnpm dev:worker
pnpm dev:web        # http://localhost:3000 (forwards /v1 and /media to the API)
```

In the desktop app set **Settings → Uploads → Server** to `http://localhost:8080`
(`http://` is accepted for localhost only). Database migrations live in
`services/api/migrations` and run automatically; `pnpm db:migrate` runs them manually.

## Tests

```bash
cargo test --workspace                       # engine tests need ffmpeg on PATH
pnpm -r test                                 # unit tests; integration tests skip without services
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cliplock_test \
TEST_S3_ENDPOINT=http://127.0.0.1:9000 TEST_S3_ACCESS_KEY_ID=minioadmin TEST_S3_SECRET_ACCESS_KEY=minioadmin \
  pnpm --filter @cliplock/api test && pnpm --filter @cliplock/worker test
node tests/discord/check-embed.mjs http://localhost:3000/c/<clip id>
```

The integration tests drop and recreate the `public` schema of `TEST_DATABASE_URL`:
point it at a throwaway database.

## Checks before a pull request

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
pnpm -r typecheck && pnpm -r test
```
