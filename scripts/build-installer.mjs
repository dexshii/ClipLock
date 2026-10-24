#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageWindows } from './package-windows.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows with Rust MSVC and Visual Studio C++ Build Tools.');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}. See docs/releasing.md for prerequisites.`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('cargo', ['--version']);
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run this command with pnpm build:installer');
run(process.execPath, [pnpm, 'install', '--frozen-lockfile']);
run(process.execPath, [resolve(root, 'scripts/fetch-ffmpeg.mjs')]);
run(process.execPath, [pnpm, '--filter', '@cliplock/shared', 'build']);
run(process.execPath, [pnpm, '--filter', '@cliplock/desktop', 'tauri', 'build', '--bundles', 'nsis']);
packageWindows(root);
