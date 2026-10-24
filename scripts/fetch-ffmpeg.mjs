#!/usr/bin/env node
// Downloads the FFmpeg/FFprobe build ClipLock bundles as Tauri sidecars and verifies its
// SHA-256 checksum.
//
//   node scripts/fetch-ffmpeg.mjs                      # Windows x64, LGPL, latest n8.x release build
//   node scripts/fetch-ffmpeg.mjs --channel master     # BtbN master build (newest capture filters)
//   FFMPEG_ZIP_URL=... FFMPEG_ZIP_SHA256=... node scripts/fetch-ffmpeg.mjs   # pinned build (release CI)
//
// Builds come from https://github.com/BtbN/FFmpeg-Builds. The LGPL variant is used so the
// bundled executables can be redistributed alongside MIT-licensed ClipLock (see
// THIRD_PARTY_NOTICES.md). For releases, pin FFMPEG_ZIP_URL/FFMPEG_ZIP_SHA256 to a
// specific autobuild so installers are reproducible.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'apps/desktop/src-tauri/binaries');
const triple = 'x86_64-pc-windows-msvc';
const channel = process.argv.includes('--channel') ? process.argv[process.argv.indexOf('--channel') + 1] : 'release';
const headers = { 'User-Agent': 'cliplock-fetch-ffmpeg', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };

async function get(url, as = 'json') {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return as === 'json' ? res.json() : as === 'text' ? res.text() : Buffer.from(await res.arrayBuffer());
}

async function resolveBuild() {
  if (process.env.FFMPEG_ZIP_URL) {
    if (!process.env.FFMPEG_ZIP_SHA256) throw new Error('FFMPEG_ZIP_SHA256 is required with FFMPEG_ZIP_URL');
    return { url: process.env.FFMPEG_ZIP_URL, sha256: process.env.FFMPEG_ZIP_SHA256.toLowerCase(), name: 'pinned' };
  }
  const release = await get('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest');
  const pattern = channel === 'master' ? /^ffmpeg-master-latest-win64-lgpl\.zip$/ : /^ffmpeg-n8\.\d+(\.\d+)?-latest-win64-lgpl-8\.\d+\.zip$/;
  const asset = release.assets.find((a) => pattern.test(a.name));
  if (!asset) throw new Error(`no asset matching ${pattern} in ${release.tag_name}: ${release.assets.map((a) => a.name).join(', ')}`);
  const sums = release.assets.find((a) => a.name === 'checksums.sha256');
  if (!sums) throw new Error('release has no checksums.sha256');
  const line = (await get(sums.browser_download_url, 'text')).split('\n').find((l) => l.trim().endsWith(asset.name));
  if (!line) throw new Error(`no checksum listed for ${asset.name}`);
  return { url: asset.browser_download_url, sha256: line.trim().split(/\s+/)[0].toLowerCase(), name: `${release.tag_name}/${asset.name}` };
}

const build = await resolveBuild();
console.log(`downloading ${build.name}`);
const zip = await get(build.url, 'buffer');
const digest = createHash('sha256').update(zip).digest('hex');
if (digest !== build.sha256) throw new Error(`checksum mismatch: expected ${build.sha256}, got ${digest}`);
console.log(`sha256 ok (${digest})`);

const work = mkdtempSync(join(tmpdir(), 'cliplock-ffmpeg-'));
const zipPath = join(work, 'ffmpeg.zip');
writeFileSync(zipPath, zip);
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${work}' -Force`], { stdio: 'inherit' });
} else {
  execFileSync('unzip', ['-q', zipPath, '-d', work], { stdio: 'inherit' });
}

function find(dir, file) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = find(p, file);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === file) return p;
  }
  return null;
}

mkdirSync(outDir, { recursive: true });
for (const tool of ['ffmpeg', 'ffprobe']) {
  const src = find(work, `${tool}.exe`);
  if (!src) throw new Error(`${tool}.exe not found in archive`);
  const dest = join(outDir, `${tool}-${triple}.exe`);
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  console.log(`→ ${dest}`);
}
const license = find(work, 'license.txt');
if (!license) throw new Error('FFmpeg archive has no license.txt; refusing to package without redistribution notices');
copyFileSync(license, join(outDir, 'FFMPEG-LICENSE.txt'));
writeFileSync(join(outDir, 'FFMPEG-SOURCE.txt'), `${build.name}\n${build.url}\nsha256 ${build.sha256}\n`);
rmSync(work, { recursive: true, force: true });
if (!existsSync(join(outDir, `ffmpeg-${triple}.exe`))) process.exit(1);
