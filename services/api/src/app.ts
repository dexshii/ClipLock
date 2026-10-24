import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { HttpError } from './lib/errors.js';
import { Storage } from './lib/storage.js';
import { authRoutes } from './routes/auth.js';
import { clipRoutes } from './routes/clips.js';
import { mediaRoutes } from './routes/media.js';
import { publicRoutes } from './routes/public.js';

export interface AppContext {
  cfg: Config;
  db: Db;
  storage: Storage;
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { cfg } = ctx;
  const app = Fastify({
    logger: cfg.LOG_LEVEL === 'silent' ? false : { level: cfg.LOG_LEVEL, redact: ['req.headers.authorization'] },
    trustProxy: (_address: string, hop: number) => hop < cfg.TRUST_PROXY_HOPS,
    bodyLimit: 1024 * 1024,
    // Clip media can take a while to stream; never time out mid-response on our side.
    requestTimeout: 0,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    // The API serves JSON and media only; the docs UI needs inline assets.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: cfg.corsOrigins,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
  });
  await app.register(rateLimit, {
    max: cfg.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    // Media requests are many small range reads; they are cheap and cacheable.
    allowList: (req) => req.url.startsWith('/media/'),
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'ClipLock API', version: '1.0.0', description: 'Self-hostable clip upload and sharing API.' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    if (hasZodFastifySchemaValidationErrors(err)) {
      const first = err.validation[0];
      return reply.code(400).send({ error: 'invalid_request', message: first?.message ?? 'Invalid request.' });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    const status = err.statusCode;
    if (status === 429) return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests. Slow down a little.' });
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong on the server.' });
  });

  await app.register(authRoutes(ctx));
  await app.register(clipRoutes(ctx));
  await app.register(publicRoutes(ctx));
  await app.register(mediaRoutes(ctx));
  return app;
}
