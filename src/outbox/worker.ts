import { config } from '../config';
import { logger } from '../common/logger';
import { pool, withTx } from '../db/pool';

const MAX_ATTEMPTS = 10;

export interface OutboxEvent {
  id: string;
  tenant_id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
}

/**
 * Pluggable publisher. The default logs the event; swap in Redis/BullMQ, Kafka, etc. without
 * touching the transactional write path (events are already durable in outbox_events).
 */
export type Publisher = (event: OutboxEvent) => Promise<void>;

const logPublisher: Publisher = async (e) => {
  logger.info('outbox event', { eventId: e.id, type: e.event_type, tenantId: e.tenant_id, aggregateId: e.aggregate_id });
};

/** Publishes one batch with FOR UPDATE SKIP LOCKED so several workers can run safely. Returns events handled. */
export async function drainOutbox(publish: Publisher = logPublisher, batch = 50): Promise<number> {
  return withTx(async (c) => {
    const { rows } = await c.query<OutboxEvent>(
      `SELECT id, tenant_id, aggregate_id, event_type, payload FROM outbox_events
       WHERE status = 'PENDING' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    for (const e of rows) {
      try {
        await publish(e);
        await c.query(`UPDATE outbox_events SET status = 'PUBLISHED', published_at = now(), attempts = attempts + 1 WHERE id = $1`, [e.id]);
      } catch (err) {
        await c.query(
          `UPDATE outbox_events SET attempts = attempts + 1, last_error = $2,
             status = CASE WHEN attempts + 1 >= $3 THEN 'FAILED' ELSE 'PENDING' END WHERE id = $1`,
          [e.id, String(err instanceof Error ? err.message : err).slice(0, 500), MAX_ATTEMPTS],
        );
      }
    }
    return rows.length;
  });
}

export function startOutboxWorker(publish: Publisher = logPublisher): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    try {
      while (!stopped && (await drainOutbox(publish)) > 0);
    } catch (e) {
      logger.error('outbox worker error', { error: e instanceof Error ? e.message : String(e) });
    }
    if (!stopped) timer = setTimeout(tick, config.OUTBOX_POLL_MS);
  };
  timer = setTimeout(tick, config.OUTBOX_POLL_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export const outboxLag = async () =>
  (await pool.query(`SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0) AS seconds FROM outbox_events WHERE status = 'PENDING'`)).rows[0].seconds;
