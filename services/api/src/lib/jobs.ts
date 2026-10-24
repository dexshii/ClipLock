import type { Queryable } from '../db.js';

export type JobKind = 'process-clip' | 'purge-clip';

export interface ProcessClipPayload {
  clipId: string;
}

export interface PurgeClipPayload {
  clipId: string;
  originalKey: string;
  uploadId: string | null;
}

export async function enqueue(db: Queryable, kind: 'process-clip', payload: ProcessClipPayload): Promise<void>;
export async function enqueue(db: Queryable, kind: 'purge-clip', payload: PurgeClipPayload): Promise<void>;
export async function enqueue(db: Queryable, kind: JobKind, payload: object): Promise<void> {
  await db.query('INSERT INTO jobs (kind, payload, max_attempts) VALUES ($1, $2, $3)', [kind, JSON.stringify(payload), kind === 'purge-clip' ? 10 : 3]);
}

export interface Job {
  id: number;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/** Claims the next runnable job. Jobs locked for longer than `staleAfterSeconds` (crashed worker) are reclaimed. */
export async function claimJob(db: Queryable, workerId: string, staleAfterSeconds = 1800): Promise<Job | null> {
  const { rows } = await db.query<Job>(
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE (status = 'queued' AND run_after <= now())
          OR (status = 'running' AND locked_at < now() - make_interval(secs => $2))
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1)
     RETURNING id, kind, payload, attempts, max_attempts`,
    [workerId, staleAfterSeconds],
  );
  return rows[0] ?? null;
}

export async function completeJob(db: Queryable, id: number): Promise<void> {
  await db.query(`UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL WHERE id = $1`, [id]);
}

/** Records a failure; retries with exponential backoff until max_attempts. Returns true if it will retry. */
export async function failJob(db: Queryable, job: Job, error: string): Promise<boolean> {
  const retry = job.attempts < job.max_attempts;
  await db.query(
    `UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL,
            run_after = now() + make_interval(secs => $4), finished_at = CASE WHEN $2 = 'failed' THEN now() END
     WHERE id = $1`,
    [job.id, retry ? 'queued' : 'failed', error.slice(0, 2000), 30 * 2 ** (job.attempts - 1)],
  );
  return retry;
}
