import { hostname } from 'node:os';
import { z } from 'zod';
import { claimJob, completeJob, createDb, failJob, loadConfig, migrate, Storage, type Job } from '@cliplock/api/core';
import { MediaError } from './media.js';
import { markFailed, processClip, purgeClip, type WorkerSettings } from './process.js';

const env = z
  .object({
    FFMPEG_PATH: z.string().default('ffmpeg'),
    FFPROBE_PATH: z.string().default('ffprobe'),
    /** libx264 (default) or a hardware encoder such as h264_nvenc on GPU servers. */
    WORKER_VIDEO_ENCODER: z.string().default('libx264'),
    WORKER_KEEP_ORIGINALS: z.enum(['true', 'false']).default('false'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
    WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
    WORKER_TRANSCODE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(3600),
  })
  .parse(process.env);

const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
await migrate(db, (m) => log(`[migrate] ${m}`));
const storage = new Storage(cfg);
const settings: WorkerSettings = {
  ffmpeg: env.FFMPEG_PATH,
  ffprobe: env.FFPROBE_PATH,
  encoder: env.WORKER_VIDEO_ENCODER,
  keepOriginals: env.WORKER_KEEP_ORIGINALS === 'true',
  maxDurationMs: cfg.MAX_CLIP_DURATION_SECONDS * 1000,
  transcodeTimeoutMs: env.WORKER_TRANSCODE_TIMEOUT_SECONDS * 1000,
};
const workerId = `${hostname()}:${process.pid}`;
let stopping = false;

function log(message: string) {
  console.log(`${new Date().toISOString()} ${message}`);
}

async function handle(job: Job): Promise<void> {
  const payload = job.payload as Record<string, string | null>;
  try {
    if (job.kind === 'process-clip') await processClip(db, storage, settings, String(payload.clipId), log);
    else if (job.kind === 'purge-clip') await purgeClip(storage, payload as { clipId: string; originalKey: string; uploadId: string | null });
    else throw new MediaError(`unknown job kind ${job.kind}`, true);
    await completeJob(db, job.id);
  } catch (e) {
    const err = e as Error;
    const permanent = e instanceof MediaError && e.permanent;
    log(`job ${job.id} (${job.kind}) failed${permanent ? ' permanently' : ''}: ${err.message}`);
    const retrying = permanent ? false : await failJob(db, job, err.message);
    if (permanent) await failJob(db, { ...job, attempts: job.max_attempts }, err.message);
    if (!retrying && job.kind === 'process-clip') {
      await markFailed(db, String(payload.clipId), permanent ? `Processing failed: ${err.message}` : 'Processing failed. Please try uploading again.');
    }
  }
}

async function loop(slot: number): Promise<void> {
  while (!stopping) {
    let job: Job | null = null;
    try {
      job = await claimJob(db, `${workerId}#${slot}`);
    } catch (e) {
      log(`claim failed: ${(e as Error).message}`);
    }
    if (!job) {
      await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
      continue;
    }
    log(`job ${job.id} ${job.kind} attempt ${job.attempts}/${job.max_attempts}`);
    await handle(job);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log(`${signal}: finishing current jobs`);
    stopping = true;
  });
}

log(`worker ${workerId} started (concurrency ${env.WORKER_CONCURRENCY}, encoder ${settings.encoder})`);
await Promise.all(Array.from({ length: env.WORKER_CONCURRENCY }, (_, i) => loop(i)));
await db.end();
