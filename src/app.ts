import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { config } from './config';
import { AppError } from './common/errors';
import { bigintReplacer } from './common/bigint';
import { logger } from './common/logger';
import { authenticate } from './auth/context';
import { pool } from './db/pool';
import { documentRouter } from './modules/document/document.routes';
import { listComponents } from './domain/registry';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('json replacer', bigintReplacer); // a raw BigInt can never be serialised to the client
  app.use(helmet());

  app.use((req, res, next) => {
    req.requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    res.setHeader('X-Request-Id', req.requestId);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info('request', {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        tenantId: req.ctx?.tenantId,
      });
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  });

  app.use(
    rateLimit({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      limit: config.RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (req, res) => {
        res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' }, requestId: req.requestId });
      },
    }),
  );
  app.use(express.json({ limit: config.MAX_BODY_BYTES }));

  const api = express.Router();
  api.use(authenticate);
  api.get('/components', (_req, res) => {
    res.json({
      success: true,
      data: listComponents().map((c) => ({ type: c.type, version: c.version, category: c.category, capabilities: c.capabilities, allowedChildren: c.allowedChildren })),
    });
  });
  api.use(documentRouter);
  app.use('/api/v1', api);

  app.use((_req, _res, next) => next(new AppError('RESOURCE_NOT_FOUND', 'Route not found')));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let e: AppError;
    const anyErr = err as { type?: string; status?: number };
    if (err instanceof AppError) e = err;
    else if (anyErr?.type === 'entity.too.large') e = new AppError('DOCUMENT_TOO_LARGE', 'Request body is too large', undefined, 413);
    else if (anyErr?.type === 'entity.parse.failed') e = new AppError('BAD_REQUEST', 'Malformed JSON body');
    else if (err instanceof RangeError) e = new AppError('DOCUMENT_TOO_LARGE', 'Payload is too deeply nested');
    else {
      logger.error('unhandled error', { requestId: req.requestId, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      e = new AppError('INTERNAL_ERROR', 'Unexpected server error');
    }
    res.status(e.status).json({ success: false, error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) }, requestId: req.requestId });
  });

  return app;
}
