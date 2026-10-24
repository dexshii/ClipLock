#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Collect the real NSIS output, redistribution notices and SHA-256 manifest. */
export function packageWindows(root, destination = join(root, 'dist/windows')) {
  const { version } = JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const installer = `ClipLock_${version}_x64-setup.exe`;
  const inputs = [
    [join(root, 'target/release/bundle/nsis', installer), installer],
    [join(root, 'LICENSE'), 'LICENSE.txt'],
    [join(root, 'THIRD_PARTY_NOTICES.md'), 'THIRD_PARTY_NOTICES.md'],
    [join(root, 'apps/desktop/src-tauri/binaries/FFMPEG-LICENSE.txt'), 'FFMPEG-LICENSE.txt'],
    [join(root, 'apps/desktop/src-tauri/binaries/FFMPEG-SOURCE.txt'), 'FFMPEG-SOURCE.txt'],
  ];
  // Validate all inputs before writing any output, including the versioned installer.
  for (const [input] of inputs) readFileSync(input);
  mkdirSync(destination, { recursive: true });
  const checksums = [];
  for (const [input, name] of inputs) {
    const output = join(destination, name);
    copyFileSync(input, output);
    checksums.push(`${createHash('sha256').update(readFileSync(output)).digest('hex')}  ${name}`);
  }
  writeFileSync(join(destination, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
  console.log(`Windows installer and checksums: ${destination}`);
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageWindows(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
