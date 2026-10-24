# Contributing to ClipLock

Thanks for helping! Bug reports, game-database additions, test results from real
hardware and code are all welcome.

## Ground rules

- Be respectful; assume good intent.
- Never contribute code, assets or UI copied from Medal, Outplayed or other proprietary
  products.
- Don't claim features work without testing them. If you verified something on real
  hardware (a GPU encoder, Discord playback, an installer), update
  `docs/verification.md` or the table in `docs/discord.md` with what you tested.
- Privacy defaults (microphone off, replay opt-in, no telemetry, manual uploads) are
  product requirements, not preferences.

## Getting started

See [docs/development.md](docs/development.md) for prerequisites, running the app and the
local server, and the test commands.

## Pull requests

1. Fork and create a branch.
2. Keep changes focused; include tests for behaviour changes.
3. Run before pushing:
   ```bash
   cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
   pnpm -r typecheck && pnpm -r test
   ```
4. Describe what you changed and how you tested it, including OS, GPU and driver for
   capture-related changes.

## Adding a game

Edit `apps/desktop/src-tauri/resources/games.json`: add `{ "id", "name", "executables" }`
with the exact executable file name(s). Keep ids lowercase-kebab and unique; the unit
tests check for duplicates.

## Commit style

Imperative subject line (“Add …”, “Fix …”), wrapped body explaining why.

By contributing you agree that your contributions are licensed under the MIT License.
