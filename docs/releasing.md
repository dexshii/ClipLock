# Releasing the Windows app

## Version

Bump the version in `apps/desktop/src-tauri/tauri.conf.json`, the workspace
`Cargo.toml` (`[workspace.package] version`) and `apps/desktop/package.json`, update
`CHANGELOG.md`, then tag: `git tag v0.2.0 && git push --tags`. The **Release** workflow
builds the NSIS installer on Windows and creates a **draft** GitHub release. Review it,
test the installer on a clean Windows VM, then publish.

## Download a development installer

Open the latest successful **CI** run under the repository's **Actions** tab.
Download **cliplock-windows-installer** from its **Artifacts** section (GitHub
sign-in is required), unzip it and run `ClipLock_<version>_x64-setup.exe`.
Artifacts are temporary development builds; permanent public downloads belong in
**Releases**. A draft release is visible only to repository collaborators until
published. The setup is unsigned unless an Authenticode certificate is configured.

## Build locally

On Windows x64 install Node.js 22+, pnpm (the version in `package.json`), Rust MSVC
(the version in `rust-toolchain.toml`) and Visual Studio 2022 Build Tools with
**Desktop development with C++** and a Windows SDK. Reopen the terminal so `cargo`
is on PATH, then run from the repository root:

```powershell
pnpm build:installer
```

This installs locked dependencies, fetches checksum-verified FFmpeg/FFprobe,
builds shared code and the desktop app, and creates the NSIS setup. The install
is per-user and provisions WebView2 if missing (internet is needed for that step).
The script collects the setup, license notices and `SHA256SUMS.txt` in
`dist/windows/`. Raw NSIS output remains in `target/release/bundle/nsis/`.
Verify the executable with `Get-FileHash .\ClipLock_<version>_x64-setup.exe -Algorithm SHA256`
and compare against `SHA256SUMS.txt`.

## Create a draft release

Push a matching version tag or use **Actions → Release → Run workflow** on the
desired commit. Manual runs derive `v<version>` from the app configuration;
tag runs reject a version mismatch. Both attach the setup, SHA-256 manifest and
redistribution notices to a draft release and upload a workflow artifact.

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

Signing keys and certificates are optional repository settings; without them,
installers are unsigned and in-app updates are disabled. A successful artifact
build alone does not validate installation, GPU capture or Discord playback.

## Release checklist

- [ ] CI green on the release commit (including the Windows job)
- [ ] Installer installs, starts, records Instant Replay and saves a clip on a clean Windows 10 and 11 VM
- [ ] Uninstaller removes the app (clips in `Videos\ClipLock` are kept)
- [ ] Upgrade from the previous version keeps settings and library
- [ ] `docs/verification.md` and `docs/discord.md` updated with what was tested
