import type { PoolClient } from 'pg';
import { z } from 'zod';
import { config } from '../../config';
import { AppError, notFound, zodIssues } from '../../common/errors';
import { checksumOf, sha256, stableStringify } from '../../common/hash';
import { Snowflake } from '../../common/ids';
import { pool, withTx, type Queryable } from '../../db/pool';
import { hasScope, SCOPES, type RequestContext } from '../../auth/context';
import { builderActionSchema, type BuilderAction } from '../../domain/actions';
import { applyActions, cloneWithNewIds, createEmptyDocument } from '../../domain/reducer';
import { diffDocuments } from '../../domain/diff';
import { collectReferences, validateDocument } from '../../domain/validate-document';
import { SCHEMA_VERSION, type DocumentJson, type Limits, type RevisionSource } from '../../domain/types';
import * as repo from './document.repository';
import type { DocumentRow } from './document.repository';

const snowflake = new Snowflake(BigInt(config.SNOWFLAKE_NODE_ID));
export const newId = () => snowflake.next();

export const limits: Limits = { maxNodes: config.MAX_NODES, maxDepth: config.MAX_DEPTH, maxBytes: config.MAX_DOCUMENT_BYTES };
const reduceDeps = { newId, maxDepth: config.MAX_DEPTH };

export interface MutationResult {
  status: number;
  body: unknown;
  replayed: boolean;
}

// ---- helpers -----------------------------------------------------------------------

const revisionNo = z.coerce.number().int().min(1).max(2_147_483_647);
const expectedRevision = z.number().int().min(1).max(2_147_483_647);

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new AppError('BAD_REQUEST', 'Invalid request body', zodIssues(r.error));
  return r.data;
}

async function requireDocument(q: Queryable, ctx: RequestContext, pageId: string, forUpdate = false): Promise<DocumentRow> {
  // 404 (not 403) so a cross-tenant BIGINT id never reveals whether a resource exists.
  const doc = await repo.findByPage(q, ctx, pageId, forUpdate);
  if (!doc) throw notFound('Document');
  return doc;
}

function assertExpected(doc: DocumentRow, expected: number) {
  if (expected !== doc.current_revision_no) {
    throw new AppError('REVISION_CONFLICT', 'Document changed. Reload and retry.', { expectedRevision: expected, currentRevision: doc.current_revision_no });
  }
}

async function assertNotLockedByOther(q: Queryable, doc: DocumentRow, ctx: RequestContext) {
  const lock = await repo.getActiveLock(q, doc.id);
  if (lock && lock.actor_id !== ctx.actorId) {
    throw new AppError('DOCUMENT_LOCKED', 'Document is locked by another editor', { lockedBy: lock.actor_id, expiresAt: lock.expires_at });
  }
}

function assertSource(ctx: RequestContext, source: RevisionSource) {
  const needed = source === 'AI' ? SCOPES.ai : source === 'IMPORT' ? SCOPES.import : null;
  if (needed && !hasScope(ctx, needed)) throw new AppError('FORBIDDEN', `Missing required permission: ${needed}`);
}

async function loadDraft(q: Queryable, doc: DocumentRow): Promise<DocumentJson> {
  const rev = doc.draft_revision_id ? await repo.getRevisionById(q, doc.id, doc.draft_revision_id) : null;
  if (!rev) throw new AppError('INTERNAL_ERROR', 'Draft revision is missing');
  return rev.document_json;
}

/**
 * Runs a mutating operation inside ONE transaction: lock the document row (serialises writers),
 * replay a stored result for a repeated Idempotency-Key, otherwise execute and record the result.
 */
async function runMutation(
  ctx: RequestContext,
  pageId: string,
  operation: string,
  idemKey: string | undefined,
  payload: unknown,
  work: (c: PoolClient, doc: DocumentRow) => Promise<{ status: number; body: unknown }>,
): Promise<MutationResult> {
  const hash = sha256(stableStringify({ pageId, operation, payload }));
  return withTx(async (c) => {
    const doc = await requireDocument(c, ctx, pageId, true);
    if (idemKey) {
      const prior = await repo.findIdempotency(c, ctx, operation, idemKey);
      if (prior) {
        if (prior.request_hash !== hash) {
          throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request');
        }
        return { status: prior.response_status, body: prior.response_json, replayed: true };
      }
    }
    const out = await work(c, doc);
    if (idemKey) {
      await repo.saveIdempotency(c, { id: newId(), ctx, operation, key: idemKey, hash, status: out.status, body: out.body, ttlHours: config.IDEMPOTENCY_TTL_HOURS });
    }
    return { ...out, replayed: false };
  });
}

interface CommitInput {
  c: PoolClient;
  ctx: RequestContext;
  doc: DocumentRow;
  next: DocumentJson;
  source: RevisionSource;
  batchActions: unknown;
  idemKey?: string;
  eventType: 'document.changed' | 'document.restored';
}

/** Steps 4-8 of the report's transaction: new revision, pointers, batch, references, outbox. */
async function commitRevision(i: CommitInput) {
  const { c, ctx, doc, next } = i;
  const stats = validateDocument(next, limits, doc.page_id);
  const no = doc.current_revision_no + 1;
  const revisionId = newId();
  const batchId = newId();
  const checksum = checksumOf(next);

  await repo.insertRevision(c, { id: revisionId, documentId: doc.id, revisionNo: no, doc: next, checksum, source: i.source, actorId: ctx.actorId });
  await repo.setDraftPointer(c, doc.id, no, revisionId);
  await repo.insertActionBatch(c, { id: batchId, documentId: doc.id, revisionId, ctx, source: i.source, idempotencyKey: i.idemKey, actions: i.batchActions });

  const refs = collectReferences(next).map((r) => ({ ...r, id: newId() }));
  const refsChanged = await repo.replaceReferences(c, ctx.tenantId, doc.id, refs);

  const base = { documentId: doc.id, pageId: doc.page_id, revision: no, revisionId, source: i.source, actorId: ctx.actorId, requestId: ctx.requestId };
  const events: Array<[string, unknown]> = [
    [i.eventType, base],
    ['document.revision.created', base],
  ];
  if (refsChanged) events.push(['media.reference.changed', { ...base, references: refs.map(({ refType, refKey, nodeId }) => ({ refType, refKey, nodeId })) }]);
  for (const [type, payload] of events) await repo.insertOutbox(c, { id: newId(), tenantId: ctx.tenantId, aggregateId: doc.id, type, payload });

  return { revision: no, revisionId, batchId, checksum, stats };
}

// ---- queries -----------------------------------------------------------------------

export async function getDocument(ctx: RequestContext, pageId: string, revision?: number) {
  const doc = await requireDocument(pool, ctx, pageId);
  const rev =
    revision === undefined
      ? await repo.getRevisionById(pool, doc.id, doc.draft_revision_id ?? '0')
      : await repo.getRevisionByNo(pool, doc.id, revision);
  if (!rev) throw notFound('Revision');
  const published = doc.published_revision_id ? await repo.getRevisionById(pool, doc.id, doc.published_revision_id) : null;
  return {
    documentId: doc.id,
    pageId: doc.page_id,
    revision: rev.revision_no,
    revisionId: rev.id,
    schemaVersion: rev.document_json.schemaVersion,
    publishedRevision: published?.revision_no ?? null,
    root: rev.document_json.root,
  };
}

export function parseRevisionQuery(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  return parseBody(z.object({ n: revisionNo }), { n: v }).n;
}

export async function listRevisions(ctx: RequestContext, pageId: string, query: { limit?: unknown; before?: unknown }) {
  const q = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), before: revisionNo.optional() }), query);
  const doc = await requireDocument(pool, ctx, pageId);
  const rows = await repo.listRevisions(pool, doc.id, q.limit, q.before);
  return {
    items: rows.map((r) => ({
      revisionId: r.id,
      revision: r.revision_no,
      source: r.source,
      checksum: r.checksum,
      createdBy: r.created_by,
      createdAt: r.created_at,
      isCurrent: r.revision_no === doc.current_revision_no,
      isPublished: r.id === doc.published_revision_id,
    })),
    nextBefore: rows.length === q.limit ? rows[rows.length - 1].revision_no : null,
  };
}

export async function getRevision(ctx: RequestContext, pageId: string, revisionId: string) {
  const doc = await requireDocument(pool, ctx, pageId);
  const rev = await repo.getRevisionById(pool, doc.id, revisionId);
  if (!rev) throw notFound('Revision');
  return {
    revisionId: rev.id,
    documentId: doc.id,
    pageId: doc.page_id,
    revision: rev.revision_no,
    source: rev.source,
    checksum: rev.checksum,
    createdBy: rev.created_by,
    createdAt: rev.created_at,
    schemaVersion: rev.document_json.schemaVersion,
    root: rev.document_json.root,
  };
}

export async function compareRevisions(ctx: RequestContext, pageId: string, query: { from?: unknown; to?: unknown }) {
  const q = parseBody(z.object({ from: revisionNo, to: revisionNo }), query);
  const doc = await requireDocument(pool, ctx, pageId);
  const [a, b] = await Promise.all([repo.getRevisionByNo(pool, doc.id, q.from), repo.getRevisionByNo(pool, doc.id, q.to)]);
  if (!a || !b) throw notFound('Revision');
  return { from: q.from, to: q.to, ...diffDocuments(a.document_json, b.document_json) };
}

// ---- commands ----------------------------------------------------------------------

export async function createDocument(ctx: RequestContext, pageId: string, body: unknown) {
  parseBody(z.object({}).strict(), body);
  try {
    return await withTx(async (c) => {
      const docId = newId();
      const revisionId = newId();
      const doc = createEmptyDocument(pageId, newId);
      await repo.insertDocument(c, ctx, docId, pageId);
      const checksum = checksumOf(doc);
      await repo.insertRevision(c, { id: revisionId, documentId: docId, revisionNo: 1, doc, checksum, source: 'SYSTEM', actorId: ctx.actorId });
      await repo.setDraftPointer(c, docId, 1, revisionId);
      await repo.insertOutbox(c, {
        id: newId(), tenantId: ctx.tenantId, aggregateId: docId, type: 'document.created',
        payload: { documentId: docId, pageId, revision: 1, revisionId, actorId: ctx.actorId, requestId: ctx.requestId },
      });
      return { documentId: docId, pageId, revision: 1, revisionId, schemaVersion: SCHEMA_VERSION, root: doc.root };
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new AppError('DOCUMENT_EXISTS', 'A document already exists for this page');
    throw e;
  }
}

const batchSchema = z
  .object({
    expectedRevision,
    actions: z.array(z.unknown()).min(1, 'at least one action is required').max(100, 'at most 100 actions per batch'),
    source: z.enum(['EDITOR', 'AI', 'IMPORT']).default('EDITOR'),
  })
  .strict();

function parseActions(raw: unknown[]): BuilderAction[] {
  return raw.map((a, i) => {
    const r = builderActionSchema.safeParse(a);
    if (!r.success) throw new AppError('ACTION_INVALID', `Action #${i} is invalid`, { actionIndex: i, issues: zodIssues(r.error) });
    return r.data;
  });
}

export async function applyActionBatch(ctx: RequestContext, pageId: string, body: unknown, idemKey?: string): Promise<MutationResult> {
  const input = parseBody(batchSchema, body);
  assertSource(ctx, input.source);
  const actions = parseActions(input.actions);

  return runMutation(ctx, pageId, 'actions', idemKey, input, async (c, doc) => {
    assertExpected(doc, input.expectedRevision);
    await assertNotLockedByOther(c, doc, ctx);
    const current = await loadDraft(c, doc);
    const { doc: next, results } = applyActions(current, actions, reduceDeps);
    const r = await commitRevision({ c, ctx, doc, next, source: input.source, batchActions: actions, idemKey, eventType: 'document.changed' });
    return {
      status: 200,
      body: { documentId: doc.id, pageId: doc.page_id, revision: r.revision, revisionId: r.revisionId, actionBatchId: r.batchId, checksum: r.checksum, results },
    };
  });
}

/** Dry run: validates (and applies in memory) without persisting anything. */
export async function validateOnly(ctx: RequestContext, pageId: string, body: unknown) {
  const input = parseBody(z.object({ expectedRevision: expectedRevision.optional(), actions: z.array(z.unknown()).max(100).optional() }).strict(), body);
  const doc = await requireDocument(pool, ctx, pageId);
  if (input.expectedRevision !== undefined) assertExpected(doc, input.expectedRevision);
  try {
    const current = await loadDraft(pool, doc);
    let next = current;
    let results: unknown[] = [];
    if (input.actions?.length) ({ doc: next, results } = applyActions(current, parseActions(input.actions), reduceDeps));
    const stats = validateDocument(next, limits, doc.page_id);
    return { valid: true, revision: doc.current_revision_no, nodeCount: stats.nodeCount, depth: stats.depth, bytes: stats.bytes, results };
  } catch (e) {
    if (e instanceof AppError && e.status === 422) return { valid: false, error: { code: e.code, message: e.message, details: e.details } };
    throw e;
  }
}

async function restoreInto(c: PoolClient, ctx: RequestContext, doc: DocumentRow, target: repo.RevisionRow, idemKey: string | undefined, kind: 'restore' | 'reset') {
  await assertNotLockedByOther(c, doc, ctx);
  const next = structuredClone(target.document_json);
  next.pageId = doc.page_id;
  const r = await commitRevision({
    c, ctx, doc, next, source: 'RESTORE', idemKey, eventType: 'document.restored',
    batchActions: [{ type: kind.toUpperCase(), fromRevision: target.revision_no, fromRevisionId: target.id }],
  });
  return { status: 200, body: { documentId: doc.id, pageId: doc.page_id, revision: r.revision, revisionId: r.revisionId, restoredFromRevision: target.revision_no, checksum: r.checksum } };
}

export async function restoreRevision(ctx: RequestContext, pageId: string, revisionId: string, body: unknown, idemKey?: string) {
  const input = parseBody(z.object({ expectedRevision }).strict(), body);
  return runMutation(ctx, pageId, 'restore', idemKey, { revisionId, ...input }, async (c, doc) => {
    assertExpected(doc, input.expectedRevision);
    const target = await repo.getRevisionById(c, doc.id, revisionId);
    if (!target) throw notFound('Revision');
    return restoreInto(c, ctx, doc, target, idemKey, 'restore');
  });
}

/** Reset to a "safe" revision: the given one, else the published one, else revision 1. */
export async function resetDocument(ctx: RequestContext, pageId: string, body: unknown, idemKey?: string) {
  const input = parseBody(z.object({ expectedRevision, revisionNo: revisionNo.optional() }).strict(), body);
  return runMutation(ctx, pageId, 'reset', idemKey, input, async (c, doc) => {
    assertExpected(doc, input.expectedRevision);
    const target = input.revisionNo
      ? await repo.getRevisionByNo(c, doc.id, input.revisionNo)
      : doc.published_revision_id
        ? await repo.getRevisionById(c, doc.id, doc.published_revision_id)
        : await repo.getRevisionByNo(c, doc.id, 1);
    if (!target) throw notFound('Revision');
    return restoreInto(c, ctx, doc, target, idemKey, 'reset');
  });
}

export async function publishDocument(ctx: RequestContext, pageId: string, body: unknown, idemKey?: string) {
  const input = parseBody(z.object({ expectedRevision: expectedRevision.optional(), revisionNo: revisionNo.optional() }).strict(), body);
  if (input.expectedRevision === undefined && input.revisionNo === undefined) {
    throw new AppError('BAD_REQUEST', 'Provide expectedRevision (publish current draft) or revisionNo (publish a specific revision)');
  }
  return runMutation(ctx, pageId, 'publish', idemKey, input, async (c, doc) => {
    if (input.expectedRevision !== undefined) assertExpected(doc, input.expectedRevision);
    const target = input.revisionNo ? await repo.getRevisionByNo(c, doc.id, input.revisionNo) : await repo.getRevisionById(c, doc.id, doc.draft_revision_id!);
    if (!target) throw notFound('Revision');
    validateDocument(target.document_json, limits, doc.page_id); // never publish an invalid document
    await repo.setPublishedPointer(c, doc.id, target.id);
    await repo.insertOutbox(c, {
      id: newId(), tenantId: ctx.tenantId, aggregateId: doc.id, type: 'page.published',
      payload: { documentId: doc.id, pageId: doc.page_id, revision: target.revision_no, revisionId: target.id, actorId: ctx.actorId, requestId: ctx.requestId },
    });
    return { status: 200, body: { documentId: doc.id, pageId: doc.page_id, publishedRevision: target.revision_no, revisionId: target.id } };
  });
}

/** Copies the current draft into a new document for another page (fresh node ids). */
export async function duplicateDocument(ctx: RequestContext, pageId: string, body: unknown) {
  const input = parseBody(z.object({ targetPageId: z.string().regex(/^[1-9]\d{0,18}$/) }).strict(), body);
  if (BigInt(input.targetPageId) > 9223372036854775807n) throw new AppError('INVALID_IDENTIFIER', 'targetPageId must fit in a 64-bit integer');
  const source = await requireDocument(pool, ctx, pageId);
  const draft = await loadDraft(pool, source);
  const copy: DocumentJson = { schemaVersion: draft.schemaVersion, pageId: input.targetPageId, root: cloneWithNewIds(draft.root, newId) };
  validateDocument(copy, limits, input.targetPageId);
  try {
    return await withTx(async (c) => {
      const docId = newId();
      const revisionId = newId();
      await repo.insertDocument(c, ctx, docId, input.targetPageId);
      await repo.insertRevision(c, { id: revisionId, documentId: docId, revisionNo: 1, doc: copy, checksum: checksumOf(copy), source: 'SYSTEM', actorId: ctx.actorId });
      await repo.setDraftPointer(c, docId, 1, revisionId);
      const refs = collectReferences(copy).map((r) => ({ ...r, id: newId() }));
      await repo.replaceReferences(c, ctx.tenantId, docId, refs);
      await repo.insertOutbox(c, {
        id: newId(), tenantId: ctx.tenantId, aggregateId: docId, type: 'document.created',
        payload: { documentId: docId, pageId: input.targetPageId, revision: 1, revisionId, duplicatedFromPageId: pageId, actorId: ctx.actorId, requestId: ctx.requestId },
      });
      return { documentId: docId, pageId: input.targetPageId, revision: 1, revisionId, duplicatedFromPageId: pageId };
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new AppError('DOCUMENT_EXISTS', 'A document already exists for the target page');
    throw e;
  }
}

// ---- locks -------------------------------------------------------------------------

const lockView = (l: repo.LockRow, ctx: RequestContext) => ({ lockId: l.id, actorId: l.actor_id, expiresAt: l.expires_at, heldByMe: l.actor_id === ctx.actorId });

export async function getLock(ctx: RequestContext, pageId: string) {
  const doc = await requireDocument(pool, ctx, pageId);
  const lock = await repo.getActiveLock(pool, doc.id);
  return { lock: lock ? lockView(lock, ctx) : null };
}

export async function acquireLock(ctx: RequestContext, pageId: string, body: unknown) {
  const input = parseBody(z.object({ ttlSeconds: z.number().int().min(5).max(900).default(config.LOCK_TTL_SECONDS) }).strict(), body);
  return withTx(async (c) => {
    const doc = await requireDocument(c, ctx, pageId, true);
    const lock = await repo.acquireLock(c, { id: newId(), documentId: doc.id, tenantId: ctx.tenantId, actorId: ctx.actorId, ttlSeconds: input.ttlSeconds });
    if (!lock) {
      const held = await repo.getActiveLock(c, doc.id);
      throw new AppError('DOCUMENT_LOCKED', 'Document is locked by another editor', { lockedBy: held?.actor_id, expiresAt: held?.expires_at });
    }
    return { lock: lockView(lock, ctx) };
  });
}

export async function releaseLock(ctx: RequestContext, pageId: string, lockId: string) {
  const doc = await requireDocument(pool, ctx, pageId);
  if (!(await repo.releaseLock(pool, doc.id, lockId, ctx.actorId))) throw notFound('Lock');
}

