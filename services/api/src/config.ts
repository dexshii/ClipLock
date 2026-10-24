import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),

  /** Public origin users share links from (serves /c/:id via the web app and /media via this API). */
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  /** Allowed browser origins for the API (the web app). Comma separated. */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  /** Number of reverse proxies in front of the API (for client IPs in rate limiting). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

  /** HMAC key for signed private media URLs. At least 32 characters. */
  MEDIA_SIGNING_SECRET: z.string().min(32),
  /** proxy: stream media through the API (works everywhere). redirect: 302 to MEDIA_CDN_BASE_URL. */
  MEDIA_DELIVERY: z.enum(['proxy', 'redirect']).default('proxy'),
  MEDIA_CDN_BASE_URL: z.url().optional(),

  S3_ENDPOINT: z.url().optional(),
  /** Endpoint written into presigned upload URLs, if clients reach storage at a different address. */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default(true),

  ALLOW_REGISTRATION: bool.default(true),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(4 * 1024 ** 3),
  MAX_CLIP_DURATION_SECONDS: z.coerce.number().int().positive().default(60 * 60),
  USER_STORAGE_QUOTA_BYTES: z.coerce.number().int().positive().default(50 * 1024 ** 3),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Requests per minute per client IP across the API. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
});

export type Config = z.infer<typeof schema> & { corsOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const c = parsed.data;
  if (c.MEDIA_DELIVERY === 'redirect' && !c.MEDIA_CDN_BASE_URL) {
    throw new Error('MEDIA_CDN_BASE_URL is required when MEDIA_DELIVERY=redirect');
  }
  return {
    ...c,
    PUBLIC_BASE_URL: c.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    corsOrigins: c.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  };
}
