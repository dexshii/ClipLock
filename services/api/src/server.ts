import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { Storage } from './lib/storage.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
await migrate(db, (m) => console.log(`[migrate] ${m}`));
const app = await buildApp({ cfg, db, storage: new Storage(cfg) });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => db.end()).then(() => process.exit(0));
  });
}

await app.listen({ host: cfg.HOST, port: cfg.PORT });
