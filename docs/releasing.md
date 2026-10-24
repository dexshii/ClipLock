# Releasing the Windows app

## Version

Bump the version in `apps/desktop/src-tauri/tauri.conf.json`, the workspace
`Cargo.toml` (`[workspace.package] version`) and `apps/desktop/package.json`, update
`CHANGELOG.md`, then tag: `git tag v0.2.0 && git push --tags`. The **Release** workflow
builds the NSIS installer on Windows and creates a **draft** GitHub release. Review it,
test the installer on a clean Windows VM, then publish.

Local build: `node scripts/fetch-ffmpeg.mjs && pnpm --filter @cliplock/desktop tauri build`
→ `target/release/bundle/nsis/ClipLock_<version>_x64-setup.exe`.

## FFmpeg sidecars

`scripts/fetch-ffmpeg.mjs` downloads an LGPL Windows build from BtbN/FFmpeg-Builds and
verifies its SHA-256 against the release's `checksums.sha256`. For reproducible
releases set repository variables `FFMPEG_ZIP_URL` and `FFMPEG_ZIP_SHA256` to a specific
autobuild. Keep `FFMPEG-SOURCE.txt` and the FFmpeg license with the release (see
`THIRD_PARTY_NOTICES.md`).

## Signed updates (required before enabling auto-update)

The updater only installs packages signed with ClipLock's key, and
`requireSignedVersion` rejects downgrades. Builds without a configured key have no
update channel at all.

1. Generate a key pair once, offline: `pnpm --filter @cliplock/desktop tauri signer generate -w cliplock-updater.key`
2. Store the private key and its password as repository secrets
   `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Back it up — losing it means existing installs can never update again.
3. Store the public key as the repository variable `UPDATER_PUBKEY`.

The workflow then produces signed update artifacts and a `latest.json`, and the app
checks `https://github.com/<repo>/releases/latest/download/latest.json`.

## Code signing (Authenticode)

Unsigned installers trigger SmartScreen warnings. To sign, add an OV/EV code-signing
certificate as `WINDOWS_CERTIFICATE` (base64 of the `.pfx`) and
`WINDOWS_CERTIFICATE_PASSWORD`. Certificates kept in an HSM or Azure Trusted Signing need
a custom `bundle.windows.signCommand` instead (see the Tauri signing guide).

**Current status:** no signing key, certificate or published release exists yet; the
release workflow has not been run. Until it is, installers are unsigned and in-app
updates are disabled.

## Release checklist

- [ ] CI green on the release commit (including the Windows job)
- [ ] Installer installs, starts, records Instant Replay and saves a clip on a clean Windows 10 and 11 VM
- [ ] Uninstaller removes the app (clips in `Videos\ClipLock` are kept)
- [ ] Upgrade from the previous version keeps settings and library
- [ ] `docs/verification.md` and `docs/discord.md` updated with what was tested
