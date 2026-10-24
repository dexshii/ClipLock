# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/dexshii/ClipLock/security/advisories/new)
for this repository. Include affected component (desktop app, API, worker, website),
version/commit, reproduction steps and impact. You will get an acknowledgement within
7 days. Coordinated disclosure: please allow up to 90 days for a fix before publishing.

## Supported versions

Only the latest release and the `main` branch receive security fixes.

## Security model (summary)

- **Recording privacy:** capture is never silent (tray icon, sidebar indicator, optional
  notification). Instant Replay and the microphone are off until the user enables them.
  Nothing is uploaded automatically; there is no telemetry.
- **Desktop:** server credentials are not stored by the app; the refresh token lives in
  the Windows Credential Manager. Tauri's asset protocol is limited to the clip and
  thumbnail folders, and deletion only touches files inside the clip folder. File
  names derived from game names/titles are sanitized (no separators, reserved names).
- **API:** Argon2id password hashing; opaque bearer tokens stored as SHA-256 hashes,
  15-minute access tokens, rotating refresh tokens with reuse detection; per-IP rate
  limiting with stricter limits on auth endpoints; all input validated with Zod;
  ownership checks return 404 for other users' clips; private media requires
  short-lived HMAC-signed URLs; unlisted content is `noindex`.
- **Uploads:** clients upload directly to object storage using presigned part URLs —
  storage credentials never leave the server. Size, duration and quota limits are
  enforced; the uploaded size is verified; uploads are probed and always re-encoded;
  originals are never served.
- **SSRF / path traversal:** the server never fetches user-supplied URLs; storage keys
  are derived only from validated ids.
- **Updates:** the updater accepts only packages signed with the project key and
  rejects downgrades (`requireSignedVersion`).
