import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packageWindows } from './package-windows.mjs';

function fixture(t, { omitLicense = false, version = '0.1.0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cliplock-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'apps/desktop/src-tauri/tauri.conf.json': JSON.stringify({ version }),
    'target/release/bundle/nsis/ClipLock_0.1.0_x64-setup.exe': 'test fixture, not an executable',
    LICENSE: 'MIT fixture',
    'THIRD_PARTY_NOTICES.md': 'notices fixture',
    'apps/desktop/src-tauri/binaries/FFMPEG-SOURCE.txt': 'build source fixture',
    ...(!omitLicense && { 'apps/desktop/src-tauri/binaries/FFMPEG-LICENSE.txt': 'LGPL fixture' }),
  };
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

test('distribution includes installer, notices and verifiable hashes', (t) => {
  const output = packageWindows(fixture(t));
  const lines = readFileSync(join(output, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  for (const line of lines) {
    const [hash, file] = line.split('  ');
    assert.equal(createHash('sha256').update(readFileSync(join(output, file))).digest('hex'), hash);
  }
});
test('missing FFmpeg license prevents packaging', (t) => {
  assert.throws(() => packageWindows(fixture(t, { omitLicense: true })), /ENOENT/);
});
test('a stale installer from another version cannot be packaged', (t) => {
  assert.throws(() => packageWindows(fixture(t, { version: '0.2.0' })), /ENOENT/);
});
