import { Router, type Request, type Response } from 'express';
import { AppError } from '../../common/errors';
import { parseId } from '../../common/bigint';
import { requireScope, SCOPES } from '../../auth/context';
import * as svc from './document.service';

export const documentRouter = Router();

const ok = (req: Request, res: Response, data: unknown, status = 200) =>
  res.status(status).json({ success: true, data, meta: { requestId: req.requestId } });

const pageId = (req: Request) => parseId(req.params.pageId, 'pageId');

function idemKey(req: Request): string | undefined {
  const k = req.header('idempotency-key');
  if (k === undefined) return undefined;
  if (!/^[\x21-\x7e]{1,255}$/.test(k)) throw new AppError('BAD_REQUEST', 'Idempotency-Key must be 1-255 printable ASCII characters');
  return k;
}

function mutation(req: Request, res: Response, r: svc.MutationResult) {
  if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
  ok(req, res, r.body, r.status);
}

const read = requireScope(SCOPES.read);
const write = requireScope(SCOPES.write);

// ---- document ------------------------------------------------------------------------
documentRouter.get('/pages/:pageId/document', read, async (req, res) => {
  ok(req, res, await svc.getDocument(req.ctx, pageId(req), svc.parseRevisionQuery(req.query.revision)));
});

documentRouter.post('/pages/:pageId/document', write, async (req, res) => {
  ok(req, res, await svc.createDocument(req.ctx, pageId(req), req.body));
});

documentRouter.post('/pages/:pageId/actions', write, async (req, res) => {
  mutation(req, res, await svc.applyActionBatch(req.ctx, pageId(req), req.body, idemKey(req)));
});

documentRouter.post('/pages/:pageId/document/validate', write, async (req, res) => {
  ok(req, res, await svc.validateOnly(req.ctx, pageId(req), req.body));
});

documentRouter.post('/pages/:pageId/document/duplicate', write, async (req, res) => {
  ok(req, res, await svc.duplicateDocument(req.ctx, pageId(req), req.body));
});

documentRouter.post('/pages/:pageId/document/reset', requireScope(SCOPES.restore), async (req, res) => {
  mutation(req, res, await svc.resetDocument(req.ctx, pageId(req), req.body, idemKey(req)));
});

documentRouter.post('/pages/:pageId/publish', requireScope(SCOPES.publish), async (req, res) => {
  mutation(req, res, await svc.publishDocument(req.ctx, pageId(req), req.body, idemKey(req)));
});

// ---- revisions (static /compare route must precede /:revisionId) -----------------------
documentRouter.get('/pages/:pageId/revisions', read, async (req, res) => {
  ok(req, res, await svc.listRevisions(req.ctx, pageId(req), req.query));
});

documentRouter.get('/pages/:pageId/revisions/compare', read, async (req, res) => {
  ok(req, res, await svc.compareRevisions(req.ctx, pageId(req), req.query));
});

documentRouter.get('/pages/:pageId/revisions/:revisionId', read, async (req, res) => {
  ok(req, res, await svc.getRevision(req.ctx, pageId(req), parseId(req.params.revisionId, 'revisionId')));
});

documentRouter.post('/pages/:pageId/revisions/:revisionId/restore', requireScope(SCOPES.restore), async (req, res) => {
  mutation(req, res, await svc.restoreRevision(req.ctx, pageId(req), parseId(req.params.revisionId, 'revisionId'), req.body, idemKey(req)));
});

// ---- locks ---------------------------------------------------------------------------
documentRouter.get('/pages/:pageId/locks', read, async (req, res) => {
  ok(req, res, await svc.getLock(req.ctx, pageId(req)));
});

documentRouter.post('/pages/:pageId/locks', write, async (req, res) => {
  ok(req, res, await svc.acquireLock(req.ctx, pageId(req), req.body));
});

documentRouter.delete('/pages/:pageId/locks/:lockId', write, async (req, res) => {
  await svc.releaseLock(req.ctx, pageId(req), parseId(req.params.lockId, 'lockId'));
  ok(req, res, { released: true });
});
