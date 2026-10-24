# Third-party notices

ClipLock's own code is released under the MIT License (see `LICENSE`).

## FFmpeg (bundled with the Windows app as separate executables)

The Windows installer ships `ffmpeg.exe` and `ffprobe.exe` from an **LGPL** build of
FFmpeg (https://ffmpeg.org) produced by https://github.com/BtbN/FFmpeg-Builds. They run
as separate processes and are not linked into ClipLock. FFmpeg is licensed under the
GNU Lesser General Public License (the exact version is in the bundled license); its license text is included in the
release as `FFMPEG-LICENSE.txt`, and the exact build (URL and SHA-256) is recorded in
`FFMPEG-SOURCE.txt`. FFmpeg source code is available from https://ffmpeg.org/download.html
and the build scripts from the BtbN repository.

The server's worker uses the FFmpeg package of its container image (Debian), which is
licensed under the GPL; it is not redistributed by this project.

## Other dependencies

Rust crates and npm packages are used under their respective licenses (predominantly
MIT, Apache-2.0, BSD and ISC). A full list can be produced with
`cargo about generate` / `pnpm licenses list`.

"Discord" is a trademark of Discord Inc. ClipLock is not affiliated with Discord,
Medal or Outplayed.
