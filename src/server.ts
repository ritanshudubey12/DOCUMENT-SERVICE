import { config } from './config';
import { logger } from './common/logger';
import { createApp } from './app';
import { pool } from './db/pool';
import { startOutboxWorker } from './outbox/worker';

const app = createApp();
const server = app.listen(config.PORT, () => logger.info('document-api listening', { port: config.PORT, env: config.NODE_ENV }));
const stopWorker = config.OUTBOX_WORKER_ENABLED ? startOutboxWorker() : () => undefined;

async function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  stopWorker();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
