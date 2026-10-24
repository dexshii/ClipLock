import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { Storage } from '../src/lib/storage.js';
import { migrate } from '../src/migrate.js';

/**
 * Integration tests need PostgreSQL and S3-compatible storage. They read
 * TEST_DATABASE_URL and TEST_S3_ENDPOINT (see CONTRIBUTING.md) and are skipped otherwise.
 */
export const integration = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_S3_ENDPOINT;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    PUBLIC_BASE_URL: 'https://clips.test',
    MEDIA_SIGNING_SECRET: 'test-secret-test-secret-test-secret-1234',
    S3_ENDPOINT: process.env.TEST_S3_ENDPOINT!,
    S3_BUCKET: `cliplock-test-${process.pid}`,
    S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? 'test',
    S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'testtesttest',
    RATE_LIMIT_PER_MINUTE: '10000',
    ...overrides,
  });
}

export async function resetDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
}

export async function setup(overrides: Record<string, string> = {}) {
  const cfg = testConfig(overrides);
  await resetDatabase(cfg.DATABASE_URL);
  const db = createDb(cfg.DATABASE_URL);
  await migrate(db, () => undefined);
  const s3 = new S3Client({
    endpoint: cfg.S3_ENDPOINT,
    region: cfg.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY },
  });
  await s3.send(new CreateBucketCommand({ Bucket: cfg.S3_BUCKET })).catch((e: { name?: string }) => {
    if (e.name !== 'BucketAlreadyOwnedByYou' && e.name !== 'BucketAlreadyExists') throw e;
  });
  const storage = new Storage(cfg);
  const app = await buildApp({ cfg, db, storage });
  return { cfg, db, storage, app };
}

export async function register(app: Awaited<ReturnType<typeof setup>>['app'], email = 'player@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'correct horse battery', displayName: 'Player One' },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  return res.json() as { accessToken: string; refreshToken: string; user: { id: string } };
}
