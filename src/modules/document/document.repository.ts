import type { Queryable } from '../../db/pool';
import type { RequestContext } from '../../auth/context';
import type { DocumentJson } from '../../domain/types';

export interface DocumentRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  workspace_id: string;
  page_id: string;
  schema_version: number;
  current_revision_no: number;
  draft_revision_id: string | null;
  published_revision_id: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface RevisionRow {
  id: string;
  document_id: string;
  revision_no: number;
  document_json: DocumentJson;
  checksum: string;
  source: string;
  created_by: string;
  created_at: Date;
}

export interface LockRow {
  id: string;
  document_id: string;
  actor_id: string;
  expires_at: Date;
  created_at: Date;
}

/** Every document lookup carries the trusted tenant/organization/workspace scope. */
export async function findByPage(q: Queryable, ctx: RequestContext, pageId: string, forUpdate = false): Promise<DocumentRow | null> {
  const r = await q.query(
    `SELECT * FROM documents WHERE page_id = $1 AND tenant_id = $2 AND organization_id = $3 AND workspace_id = $4 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [pageId, ctx.tenantId, ctx.organizationId, ctx.workspaceId],
  );
  return r.rows[0] ?? null;
}

export async function insertDocument(q: Queryable, ctx: RequestContext, id: string, pageId: string) {
  await q.query(
    `INSERT INTO documents (id, tenant_id, organization_id, workspace_id, page_id, schema_version, current_revision_no, created_by)
     VALUES ($1,$2,$3,$4,$5,1,1,$6)`,
    [id, ctx.tenantId, ctx.organizationId, ctx.workspaceId, pageId, ctx.actorId],
  );
}

export async function insertRevision(
  q: Queryable,
  p: { id: string; documentId: string; revisionNo: number; doc: DocumentJson; checksum: string; source: string; actorId: string },
) {
  await q.query(
    `INSERT INTO document_revisions (id, document_id, revision_no, document_json, checksum, source, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
    [p.id, p.documentId, p.revisionNo, JSON.stringify(p.doc), p.checksum, p.source, p.actorId],
  );
}

export async function setDraftPointer(q: Queryable, documentId: string, revisionNo: number, revisionId: string) {
  await q.query(`UPDATE documents SET current_revision_no = $2, draft_revision_id = $3, updated_at = now() WHERE id = $1`, [documentId, revisionNo, revisionId]);
}

export async function setPublishedPointer(q: Queryable, documentId: string, revisionId: string) {
  await q.query(`UPDATE documents SET published_revision_id = $2, updated_at = now() WHERE id = $1`, [documentId, revisionId]);
}

export async function getRevisionByNo(q: Queryable, documentId: string, no: number): Promise<RevisionRow | null> {
  const r = await q.query(`SELECT * FROM document_revisions WHERE document_id = $1 AND revision_no = $2`, [documentId, no]);
  return r.rows[0] ?? null;
}

export async function getRevisionById(q: Queryable, documentId: string, id: string): Promise<RevisionRow | null> {
  const r = await q.query(`SELECT * FROM document_revisions WHERE document_id = $1 AND id = $2`, [documentId, id]);
  return r.rows[0] ?? null;
}

export async function listRevisions(q: Queryable, documentId: string, limit: number, before?: number) {
  const r = await q.query(
    `SELECT id, revision_no, checksum, source, created_by, created_at FROM document_revisions
     WHERE document_id = $1 AND ($2::int IS NULL OR revision_no < $2) ORDER BY revision_no DESC LIMIT $3`,
    [documentId, before ?? null, limit],
  );
  return r.rows as Array<Omit<RevisionRow, 'document_id' | 'document_json'>>;
}

export async function insertActionBatch(
  q: Queryable,
  p: { id: string; documentId: string; revisionId: string; ctx: RequestContext; source: string; idempotencyKey?: string; actions: unknown },
) {
  await q.query(
    `INSERT INTO document_action_batches (id, document_id, revision_id, tenant_id, actor_id, source, request_id, idempotency_key, actions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [p.id, p.documentId, p.revisionId, p.ctx.tenantId, p.ctx.actorId, p.source, p.ctx.requestId, p.idempotencyKey ?? null, JSON.stringify(p.actions)],
  );
}

/** Replaces the draft's dependency set. Returns true if the set of media references changed. */
export async function replaceReferences(
  q: Queryable,
  tenantId: string,
  documentId: string,
  refs: Array<{ id: string; refType: string; refKey: string; nodeId: string }>,
): Promise<boolean> {
  const before = await q.query(`SELECT ref_type, ref_key, node_id FROM document_references WHERE document_id = $1`, [documentId]);
  const sig = (a: Array<[string, string, string]>) => a.map((x) => x.join(':')).sort().join('|');
  const prev = sig(before.rows.map((r) => [r.ref_type, r.ref_key, r.node_id]));
  const curr = sig(refs.map((r) => [r.refType, r.refKey, r.nodeId]));
  if (prev === curr) return false;
  await q.query(`DELETE FROM document_references WHERE document_id = $1`, [documentId]);
  if (refs.length) {
    await q.query(
      `INSERT INTO document_references (id, document_id, tenant_id, ref_type, ref_key, node_id)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::bigint[])`,
      [refs.map((r) => r.id), refs.map(() => documentId), refs.map(() => tenantId), refs.map((r) => r.refType), refs.map((r) => r.refKey), refs.map((r) => r.nodeId)],
    );
  }
  return true;
}

export async function insertOutbox(q: Queryable, p: { id: string; tenantId: string; aggregateId: string; type: string; payload: unknown }) {
  await q.query(
    `INSERT INTO outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1,$2,'document',$3,$4,$5::jsonb)`,
    [p.id, p.tenantId, p.aggregateId, p.type, JSON.stringify(p.payload)],
  );
}

export async function findIdempotency(q: Queryable, ctx: RequestContext, operation: string, key: string) {
  const r = await q.query(
    `SELECT request_hash, response_status, response_json FROM idempotency_keys
     WHERE tenant_id = $1 AND actor_id = $2 AND operation = $3 AND idempotency_key = $4 AND expires_at > now()`,
    [ctx.tenantId, ctx.actorId, operation, key],
  );
  return (r.rows[0] as { request_hash: string; response_status: number; response_json: unknown } | undefined) ?? null;
}

export async function saveIdempotency(
  q: Queryable,
  p: { id: string; ctx: RequestContext; operation: string; key: string; hash: string; status: number; body: unknown; ttlHours: number },
) {
  await q.query(
    `INSERT INTO idempotency_keys (id, tenant_id, actor_id, operation, idempotency_key, request_hash, response_status, response_json, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, now() + ($9 * interval '1 hour'))
     ON CONFLICT (tenant_id, actor_id, operation, idempotency_key) DO UPDATE
       SET id = EXCLUDED.id, request_hash = EXCLUDED.request_hash, response_status = EXCLUDED.response_status,
           response_json = EXCLUDED.response_json, expires_at = EXCLUDED.expires_at, created_at = now()
       WHERE idempotency_keys.expires_at <= now()`,
    [p.id, p.ctx.tenantId, p.ctx.actorId, p.operation, p.key, p.hash, p.status, JSON.stringify(p.body), p.ttlHours],
  );
}

export async function getActiveLock(q: Queryable, documentId: string): Promise<LockRow | null> {
  const r = await q.query(`SELECT * FROM document_locks WHERE document_id = $1 AND expires_at > now()`, [documentId]);
  return r.rows[0] ?? null;
}

/** Acquires or renews the lock. Returns null if another actor holds an unexpired lock. */
export async function acquireLock(
  q: Queryable,
  p: { id: string; documentId: string; tenantId: string; actorId: string; ttlSeconds: number },
): Promise<LockRow | null> {
  const r = await q.query(
    `INSERT INTO document_locks (id, document_id, tenant_id, actor_id, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 * interval '1 second'))
     ON CONFLICT (document_id) DO UPDATE SET
       id = CASE WHEN document_locks.actor_id = EXCLUDED.actor_id AND document_locks.expires_at > now() THEN document_locks.id ELSE EXCLUDED.id END,
       actor_id = EXCLUDED.actor_id, expires_at = EXCLUDED.expires_at, created_at = now()
     WHERE document_locks.expires_at <= now() OR document_locks.actor_id = EXCLUDED.actor_id
     RETURNING *`,
    [p.id, p.documentId, p.tenantId, p.actorId, p.ttlSeconds],
  );
  return r.rows[0] ?? null;
}

export async function releaseLock(q: Queryable, documentId: string, lockId: string, actorId: string): Promise<boolean> {
  const r = await q.query(`DELETE FROM document_locks WHERE id = $1 AND document_id = $2 AND actor_id = $3`, [lockId, documentId, actorId]);
  return (r.rowCount ?? 0) > 0;
}
