/**
 * Integration tests: real Express app + real PostgreSQL (DATABASE_URL from .env). Run `npm run migrate` first.
 * Every endpoint is exercised over HTTP, including concurrency, idempotency, RBAC and tenant isolation.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { drainOutbox, type OutboxEvent } from '../src/outbox/worker';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

interface TokOpts { tenant?: string; org?: string; ws?: string; actor?: string; scopes?: string[]; secret?: string; expiresIn?: number | string; claims?: Record<string, unknown> }
const tok = (o: TokOpts = {}) =>
  jwt.sign(
    { tenantId: o.tenant ?? '1001', organizationId: o.org ?? '2001', workspaceId: o.ws ?? '3001', scopes: o.scopes ?? ['document:*'], roles: [], ...o.claims },
    o.secret ?? config.JWT_SECRET,
    { algorithm: 'HS256', subject: o.actor ?? '4001', expiresIn: (o.expiresIn ?? 3600) as number },
  );
const A = tok();
const B = tok({ actor: '4002' });

interface Res { status: number; body: any; headers: Headers }
async function call(method: string, path: string, o: { token?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  const token = o.token === undefined ? A : o.token;
  if (token) headers.authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (o.raw !== undefined) { body = o.raw; headers['content-type'] = 'application/json'; }
  else if (o.body !== undefined) { body = JSON.stringify(o.body); headers['content-type'] = 'application/json'; }
  const r = await fetch(base + path, { method, headers, body });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}

const uniq = () => String(Date.now()) + String(Math.floor(Math.random() * 9000) + 1000);
async function newPage(token: string = A) {
  const pageId = uniq();
  const r = await call('POST', `/api/v1/pages/${pageId}/document`, { token, body: {} });
  expect(r.status).toBe(200);
  return { pageId, rootId: r.body.data.root.id as string, firstRevisionId: r.body.data.revisionId as string, rev: 1, documentId: r.body.data.documentId as string };
}
const act = (pageId: string, expected: number, actions: unknown[], o: { token?: string; headers?: Record<string, string>; extra?: object } = {}) =>
  call('POST', `/api/v1/pages/${pageId}/actions`, { token: o.token, headers: o.headers, body: { expectedRevision: expected, actions, ...o.extra } });
const add = (parentId: string, componentType: string, extra: object = {}) => ({ type: 'ADD_NODE', parentId, componentType, ...extra });
const errOf = (r: Res) => r.body?.error?.code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('health, registry, routing', () => {
  it('health endpoints need no auth', async () => {
    expect((await call('GET', '/health', { token: null })).body).toEqual({ status: 'ok' });
    expect((await call('GET', '/health/ready', { token: null })).body).toEqual({ status: 'ready' });
  });
  it('unknown route -> 404 envelope; response carries request id', async () => {
    const r = await call('GET', '/api/v1/nope');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ success: false, error: { code: 'RESOURCE_NOT_FOUND' } });
    expect(r.headers.get('x-request-id')).toMatch(/^req_/);
    expect(r.body.requestId).toBe(r.headers.get('x-request-id'));
  });
  it('component registry lists capabilities', async () => {
    const r = await call('GET', '/api/v1/components');
    expect(r.status).toBe(200);
    const hero = r.body.data.find((c: any) => c.type === 'hero');
    expect(hero.capabilities).toContain('media');
    expect(hero.allowedChildren).toContain('heading');
  });
});

describe('authentication', () => {
  const path = '/api/v1/pages/1/document';
  it('rejects missing, malformed, expired, wrong-secret and incomplete tokens (401)', async () => {
    const cases: Array<string | null> = [
      null,
      'garbage',
      tok({ expiresIn: -10 }),
      tok({ secret: 'x'.repeat(40) }),
      jwt.sign({ tenantId: '1' }, config.JWT_SECRET, { subject: '1' }), // missing org/workspace
      jwt.sign({ tenantId: 1001, organizationId: 2001, workspaceId: 3001 }, config.JWT_SECRET, { subject: '1' }), // numeric ids are unsafe
      jwt.sign({ tenantId: '1001', organizationId: '2001', workspaceId: '3001' }, config.JWT_SECRET, { subject: 'abc' }),
    ];
    for (const t of cases) {
      const r = await call('GET', path, { token: t });
      expect(r.status, String(t).slice(0, 20)).toBe(401);
      expect(errOf(r)).toBe('AUTH_REQUIRED');
    }
    // alg=none must never be accepted
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: '1', tenantId: '1001', organizationId: '2001', workspaceId: '3001' })).toString('base64url')}.`;
    expect((await call('GET', path, { token: none })).status).toBe(401);
  });
  it('client-supplied tenant headers/query/body are ignored', async () => {
    const p = await newPage();
    const r = await call('GET', `/api/v1/pages/${p.pageId}/document?tenantId=1002`, { token: tok({ tenant: '1002' }), headers: { 'x-tenant-id': '1001' } });
    expect(r.status).toBe(404);
  });
});

describe('create + read', () => {
  it('creates at revision 1, rejects duplicates, bad ids and unknown body keys', async () => {
    const p = await newPage();
    const dup = await call('POST', `/api/v1/pages/${p.pageId}/document`, { body: {} });
    expect([dup.status, errOf(dup)]).toEqual([409, 'DOCUMENT_EXISTS']);
    for (const bad of ['abc', '0', '-5', '01', '9223372036854775808', '1.5']) {
      const r = await call('POST', `/api/v1/pages/${bad}/document`, { body: {} });
      expect([r.status, errOf(r)], bad).toEqual([400, 'INVALID_IDENTIFIER']);
    }
    const extra = await call('POST', `/api/v1/pages/${uniq()}/document`, { body: { tenantId: '9' } });
    expect([extra.status, errOf(extra)]).toEqual([400, 'BAD_REQUEST']);
    const ro = await call('POST', `/api/v1/pages/${uniq()}/document`, { token: tok({ scopes: ['document:read'] }), body: {} });
    expect([ro.status, errOf(ro)]).toEqual([403, 'FORBIDDEN']);
  });

  it('GET draft / exact revision; ids are strings', async () => {
    const p = await newPage();
    const r = await call('GET', `/api/v1/pages/${p.pageId}/document`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ documentId: p.documentId, pageId: p.pageId, revision: 1, schemaVersion: 1, publishedRevision: null });
    expect(typeof r.body.data.root.id).toBe('string');
    expect(r.body.data.root.type).toBe('page');
    expect((await call('GET', `/api/v1/pages/${p.pageId}/document?revision=1`)).body.data.revision).toBe(1);
    for (const [q, status, code] of [['999', 404, 'RESOURCE_NOT_FOUND'], ['abc', 400, 'BAD_REQUEST'], ['0', 400, 'BAD_REQUEST'], ['-1', 400, 'BAD_REQUEST'], ['1.5', 400, 'BAD_REQUEST']] as const) {
      const x = await call('GET', `/api/v1/pages/${p.pageId}/document?revision=${q}`);
      expect([x.status, errOf(x)], q).toEqual([status, code]);
    }
    expect((await call('GET', '/api/v1/pages/999999999999999999/document')).status).toBe(404);
  });
});

describe('actions: correctness, atomicity, limits', () => {
  it('applies every action type through the HTTP API', async () => {
    const p = await newPage();
    let rev = 1;
    const send = async (actions: unknown[]) => {
      const r = await act(p.pageId, rev, actions);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data.revision).toBe(rev + 1);
      rev = r.body.data.revision;
      return r.body.data.results as Array<{ createdNodeIds: string[] }>;
    };
    const hero = (await send([add(p.rootId, 'hero', { props: { title: 'Hi' } })]))[0].createdNodeIds[0];
    const head = (await send([add(hero, 'heading')]))[0].createdNodeIds[0];
    const btn = (await send([add(hero, 'button', { props: { label: 'Go' } })]))[0].createdNodeIds[0];
    await send([{ type: 'UPDATE_PROPS', nodeId: head, patch: { text: 'Welcome' } }]);
    await send([{ type: 'UPDATE_STYLES', nodeId: hero, patch: { backgroundColor: '#111827', paddingTop: '80px' } }]);
    await send([{ type: 'UPDATE_RESPONSIVE', nodeId: hero, device: 'mobile', patch: { paddingTop: '40px' } }]);
    await send([{ type: 'UPDATE_VISIBILITY', nodeId: hero, patch: { tablet: false } }]);
    await send([{ type: 'HIDE_NODE', nodeId: btn }, { type: 'SHOW_NODE', nodeId: btn, devices: ['desktop'] }]);
    await send([{ type: 'UPDATE_LINK', nodeId: btn, link: { href: 'https://example.com', target: '_blank' } }]);
    await send([{ type: 'REPLACE_MEDIA', nodeId: hero, assetId: '9007199254740993' }]);
    const dup = (await send([{ type: 'DUPLICATE_NODE', nodeId: btn }]))[0].createdNodeIds[0];
    await send([{ type: 'DELETE_NODE', nodeId: dup }]);
    await send([{ type: 'MOVE_NODE', nodeId: btn, newParentId: p.rootId, index: 0 }]);
    const wrap = (await send([{ type: 'WRAP_NODE', nodeId: btn, wrapperType: 'container' }]))[0].createdNodeIds[0];
    await send([{ type: 'UNWRAP_NODE', nodeId: wrap }]);
    await send([{ type: 'REORDER_CHILDREN', parentId: p.rootId, childIds: [hero, btn] }]);
    await send([{ type: 'LOCK_NODE', nodeId: hero }]);
    const locked = await act(p.pageId, rev, [{ type: 'UPDATE_PROPS', nodeId: hero, patch: { title: 'x' } }]);
    expect([locked.status, errOf(locked), locked.body.error.details.reason]).toEqual([422, 'ACTION_INVALID', 'NODE_LOCKED']);
    await send([{ type: 'UNLOCK_NODE', nodeId: hero }]);
    await send([
      { type: 'INSERT_BLOCK', parentId: p.rootId, block: { type: 'testimonial', props: { quote: 'q', rating: 5 }, children: [{ type: 'heading' }] } },
      { type: 'APPLY_THEME', tokens: { primary: '#000' } },
    ]);
    const doc = (await call('GET', `/api/v1/pages/${p.pageId}/document`)).body.data;
    expect(doc.revision).toBe(rev);
    const h = doc.root.children.find((c: any) => c.id === hero);
    expect(h.props.mediaAssetId).toBe('9007199254740993'); // exact, > 2^53
    expect(h.styles).toMatchObject({ backgroundColor: '#111827', paddingTop: '80px' });
    expect(h.responsive.mobile).toEqual({ paddingTop: '40px' });
    expect(h.visibility).toEqual({ desktop: true, tablet: false, mobile: true });
    expect(h.children[0].props.text).toBe('Welcome');
    expect(doc.root.props.theme).toEqual({ primary: '#000' });
    expect(doc.root.children.some((c: any) => c.type === 'testimonial')).toBe(true);
  });

  it('is atomic: a failing action rejects the batch and creates no revision', async () => {
    const p = await newPage();
    const r = await act(p.pageId, 1, [add(p.rootId, 'heading'), add(p.rootId, 'marquee')]);
    expect([r.status, errOf(r), r.body.error.details.actionIndex]).toEqual([422, 'COMPONENT_NOT_FOUND', 1]);
    const d = (await call('GET', `/api/v1/pages/${p.pageId}/document`)).body.data;
    expect([d.revision, d.root.children.length]).toEqual([1, 0]);
  });

  it('validates the request envelope', async () => {
    const p = await newPage();
    const url = `/api/v1/pages/${p.pageId}/actions`;
    const cases: Array<[unknown, number, string]> = [
      [{ actions: [add(p.rootId, 'text')] }, 400, 'BAD_REQUEST'],
      [{ expectedRevision: 1 }, 400, 'BAD_REQUEST'],
      [{ expectedRevision: 1, actions: [] }, 400, 'BAD_REQUEST'],
      [{ expectedRevision: 0, actions: [add(p.rootId, 'text')] }, 400, 'BAD_REQUEST'],
      [{ expectedRevision: '1', actions: [add(p.rootId, 'text')] }, 400, 'BAD_REQUEST'],
      [{ expectedRevision: 1.5, actions: [add(p.rootId, 'text')] }, 400, 'BAD_REQUEST'],
      [{ expectedRevision: 1, actions: Array(101).fill(add(p.rootId, 'text')) }, 400, 'BAD_REQUEST'],
      [{ expectedRevision: 1, source: 'HACK', actions: [add(p.rootId, 'text')] }, 400, 'BAD_REQUEST'],
      [{ expectedRevision: 1, actions: [add(p.rootId, 'text')], tenantId: '1' }, 400, 'BAD_REQUEST'],
      [{ expectedRevision: 1, actions: [{ type: 'EXPLODE' }] }, 422, 'ACTION_INVALID'],
      [{ expectedRevision: 1, actions: [{ type: 'DELETE_NODE', nodeId: 12345 }] }, 422, 'ACTION_INVALID'],
      [{ expectedRevision: 1, actions: [{ type: 'DELETE_NODE', nodeId: '999999999999' }] }, 422, 'ACTION_INVALID'],
    ];
    for (const [body, status, code] of cases) {
      const r = await call('POST', url, { body });
      expect([r.status, errOf(r)], JSON.stringify(body).slice(0, 80)).toEqual([status, code]);
    }
    expect((await call('POST', url, { raw: '{ nope' })).status).toBe(400);
    expect((await call('POST', url, {})).status).toBe(400); // no body at all
    expect((await call('GET', `/api/v1/pages/${p.pageId}/document`)).body.data.revision).toBe(1);
  });

  it('enforces size limits without crashing (413 / depth / nesting)', async () => {
    const p = await newPage();
    const big = await call('POST', `/api/v1/pages/${p.pageId}/actions`, { body: { expectedRevision: 1, actions: [{ type: 'UPDATE_PROPS', nodeId: p.rootId, patch: { title: 'x'.repeat(3_000_000) } }] } });
    expect([big.status, errOf(big)]).toEqual([413, 'DOCUMENT_TOO_LARGE']);
    // a block that lands exactly on MAX_DEPTH is fine; one level deeper is rejected
    const nested = (n: number) => { let b: any = { type: 'container' }; for (let i = 1; i < n; i++) b = { type: 'container', children: [b] }; return b; };
    const okDepth = await act(p.pageId, 1, [{ type: 'INSERT_BLOCK', parentId: p.rootId, block: nested(config.MAX_DEPTH - 1) }]);
    expect(okDepth.status, JSON.stringify(okDepth.body)).toBe(200);
    const tooDeep = await act(p.pageId, 2, [{ type: 'INSERT_BLOCK', parentId: p.rootId, block: nested(config.MAX_DEPTH) }]);
    expect([tooDeep.status, errOf(tooDeep)]).toEqual([422, 'DOCUMENT_TOO_LARGE']);
    // block deeper than MAX_DEPTH
    let block: any = { type: 'container' };
    for (let i = 0; i < config.MAX_DEPTH + 2; i++) block = { type: 'container', children: [block] };
    const deep = await act(p.pageId, 2, [{ type: 'INSERT_BLOCK', parentId: p.rootId, block }]);
    expect([deep.status, errOf(deep)]).toEqual([422, 'DOCUMENT_TOO_LARGE']);
    // pathological JSON nesting must not produce a 500
    const nest = await call('POST', `/api/v1/pages/${p.pageId}/actions`, { raw: `{"expectedRevision":1,"actions":[{"type":"INSERT_BLOCK","parentId":"1","block":${'{"children":['.repeat(20000)}${']}'.repeat(20000)}}]}` });
    expect(nest.status).toBeLessThan(500);
    expect((await call('GET', `/api/v1/pages/${p.pageId}/document`)).body.data.revision).toBe(2);
  });

  it('rejects unsafe content end-to-end', async () => {
    const p = await newPage();
    const hero = (await act(p.pageId, 1, [add(p.rootId, 'hero')])).body.data.results[0].createdNodeIds[0];
    const bad: unknown[] = [
      { type: 'UPDATE_LINK', nodeId: hero, link: { href: 'javascript:alert(1)' } },
      { type: 'UPDATE_PROPS', nodeId: hero, patch: { description: '<script>x</script>' } },
      { type: 'UPDATE_PROPS', nodeId: hero, patch: { description: '<a onclick=x()>' } },
      { type: 'UPDATE_STYLES', nodeId: hero, patch: { backgroundColor: 'url(http://x/y)' } },
    ];
    for (const a of bad) expect(errOf(await act(p.pageId, 2, [a])), JSON.stringify(a)).toBe('UNSAFE_CONTENT');
    expect(errOf(await act(p.pageId, 2, [{ type: 'UPDATE_PROPS', nodeId: hero, patch: { link: { href: 'https://ok.example' } } }]))).toBe('ACTION_INVALID');
    expect(errOf(await act(p.pageId, 2, [{ type: 'UPDATE_PROPS', nodeId: hero, patch: { nope: 1 } }]))).toBe('ACTION_INVALID');
    expect(errOf(await act(p.pageId, 2, [{ type: 'UPDATE_PROPS', nodeId: hero, patch: { mediaAssetId: '12abc' } }]))).toBe('ACTION_INVALID');
  });

  it('source=AI / IMPORT need their own scopes and are recorded on the revision', async () => {
    const p = await newPage();
    const writer = tok({ scopes: ['document:read', 'document:write'] });
    const denied = await act(p.pageId, 1, [add(p.rootId, 'text')], { token: writer, extra: { source: 'AI' } });
    expect([denied.status, errOf(denied)]).toEqual([403, 'FORBIDDEN']);
    const aiTok = tok({ scopes: ['document:read', 'document:write', 'document:ai'] });
    expect((await act(p.pageId, 1, [add(p.rootId, 'text')], { token: aiTok, extra: { source: 'AI' } })).status).toBe(200);
    const imp = tok({ scopes: ['document:read', 'document:write', 'document:import'] });
    expect((await act(p.pageId, 2, [add(p.rootId, 'text')], { token: imp, extra: { source: 'IMPORT' } })).status).toBe(200);
    const list = (await call('GET', `/api/v1/pages/${p.pageId}/revisions`)).body.data.items.map((i: any) => i.source);
    expect(list).toEqual(['IMPORT', 'AI', 'SYSTEM']);
  });
});

describe('concurrency and idempotency', () => {
  it('parallel writers with the same expectedRevision: exactly one wins, the rest get 409', async () => {
    const p = await newPage();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => act(p.pageId, 1, [add(p.rootId, 'heading', { props: { text: `w${i}` } })])));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error).toMatchObject({ code: 'REVISION_CONFLICT', details: { expectedRevision: 1, currentRevision: 2 } });
    const d = (await call('GET', `/api/v1/pages/${p.pageId}/document`)).body.data;
    expect([d.revision, d.root.children.length]).toEqual([2, 1]);
    expect((await call('GET', `/api/v1/pages/${p.pageId}/revisions`)).body.data.items).toHaveLength(2);
  });

  it('parallel retries with one Idempotency-Key create exactly one revision', async () => {
    const p = await newPage();
    const h = { 'idempotency-key': `k-${p.pageId}` };
    const rs = await Promise.all(Array.from({ length: 6 }, () => act(p.pageId, 1, [add(p.rootId, 'text')], { headers: h })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.body.data.revisionId)).size).toBe(1);
    expect(rs.filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(5);
    expect((await call('GET', `/api/v1/pages/${p.pageId}/document`)).body.data.revision).toBe(2);
    // same key, different body -> conflict; keys are scoped per actor
    const diff = await act(p.pageId, 1, [add(p.rootId, 'heading')], { headers: h });
    expect([diff.status, errOf(diff)]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    const other = await act(p.pageId, 2, [add(p.rootId, 'heading')], { headers: h, token: B });
    expect(other.status).toBe(200); // actor B's key space is independent
    expect(other.headers.get('idempotent-replayed')).toBeNull();
  });

  it('a failed request does not poison its key; bad key format is rejected', async () => {
    const p = await newPage();
    const h = { 'idempotency-key': `fail-${p.pageId}` };
    expect((await act(p.pageId, 1, [add(p.rootId, 'marquee')], { headers: h })).status).toBe(422);
    expect((await act(p.pageId, 1, [add(p.rootId, 'text')], { headers: h })).status).toBe(200);
    const bad = await act(p.pageId, 2, [add(p.rootId, 'text')], { headers: { 'idempotency-key': 'has space' } });
    expect([bad.status, errOf(bad)]).toEqual([400, 'BAD_REQUEST']);
  });

  it('restore / reset / publish are idempotent too', async () => {
    const p = await newPage();
    await act(p.pageId, 1, [add(p.rootId, 'text')]);
    const h = { 'idempotency-key': `r-${p.pageId}` };
    const r1 = await call('POST', `/api/v1/pages/${p.pageId}/revisions/${p.firstRevisionId}/restore`, { body: { expectedRevision: 2 }, headers: h });
    const r2 = await call('POST', `/api/v1/pages/${p.pageId}/revisions/${p.firstRevisionId}/restore`, { body: { expectedRevision: 2 }, headers: h });
    expect([r1.status, r2.status, r2.headers.get('idempotent-replayed')]).toEqual([200, 200, 'true']);
    expect(r2.body.data.revisionId).toBe(r1.body.data.revisionId);
    const p1 = await call('POST', `/api/v1/pages/${p.pageId}/publish`, { body: { expectedRevision: 3 }, headers: { 'idempotency-key': `p-${p.pageId}` } });
    const p2 = await call('POST', `/api/v1/pages/${p.pageId}/publish`, { body: { expectedRevision: 3 }, headers: { 'idempotency-key': `p-${p.pageId}` } });
    expect([p1.status, p2.status, p2.headers.get('idempotent-replayed')]).toEqual([200, 200, 'true']);
  });
});

describe('validate (dry run)', () => {
  it('validates without persisting', async () => {
    const p = await newPage();
    const url = `/api/v1/pages/${p.pageId}/document/validate`;
    const ok = await call('POST', url, { body: { expectedRevision: 1, actions: [add(p.rootId, 'heading')] } });
    expect(ok.body.data).toMatchObject({ valid: true, revision: 1, nodeCount: 2 });
    const invalid = await call('POST', url, { body: { actions: [add(p.rootId, 'marquee')] } });
    expect([invalid.status, invalid.body.data.valid, invalid.body.data.error.code]).toEqual([200, false, 'COMPONENT_NOT_FOUND']);
    expect((await call('POST', url, { body: {} })).body.data.valid).toBe(true); // validates the stored draft
    expect(errOf(await call('POST', url, { body: { expectedRevision: 5 } }))).toBe('REVISION_CONFLICT');
    expect((await call('POST', url, { body: {}, token: tok({ scopes: ['document:read'] }) })).status).toBe(403);
    expect((await call('GET', `/api/v1/pages/${p.pageId}/document`)).body.data.revision).toBe(1);
  });
});

describe('revisions, restore, reset, publish', () => {
  it('lists with pagination, reads, compares', async () => {
    const p = await newPage();
    for (let i = 1; i <= 4; i++) await act(p.pageId, i, [add(p.rootId, 'text')]);
    const base = `/api/v1/pages/${p.pageId}`;
    const page1 = (await call('GET', `${base}/revisions?limit=2`)).body.data;
    expect(page1.items.map((i: any) => i.revision)).toEqual([5, 4]);
    expect(page1.items[0].isCurrent).toBe(true);
    expect(page1.nextBefore).toBe(4);
    const page2 = (await call('GET', `${base}/revisions?limit=2&before=${page1.nextBefore}`)).body.data;
    expect(page2.items.map((i: any) => i.revision)).toEqual([3, 2]);
    expect((await call('GET', `${base}/revisions?limit=500`)).status).toBe(400);
    expect((await call('GET', `${base}/revisions?limit=abc`)).status).toBe(400);

    const rev = await call('GET', `${base}/revisions/${p.firstRevisionId}`);
    expect(rev.body.data).toMatchObject({ revision: 1, source: 'SYSTEM', pageId: p.pageId });
    expect((await call('GET', `${base}/revisions/999999999999`)).status).toBe(404);
    expect((await call('GET', `${base}/revisions/abc`)).status).toBe(400);

    const cmp = (await call('GET', `${base}/revisions/compare?from=1&to=5`)).body.data;
    expect(cmp.summary).toMatchObject({ added: 4, removed: 0 });
    const rev2 = (await call('GET', `${base}/revisions/compare?from=5&to=1`)).body.data;
    expect(rev2.summary.removed).toBe(4);
    for (const q of ['', '?from=1', '?from=a&to=2', '?from=0&to=1']) expect((await call('GET', `${base}/revisions/compare${q}`)).status, q).toBe(400);
    expect((await call('GET', `${base}/revisions/compare?from=1&to=99`)).status).toBe(404);
  });

  it('a revision id from another document is not readable or restorable', async () => {
    const p1 = await newPage();
    const p2 = await newPage();
    expect((await call('GET', `/api/v1/pages/${p1.pageId}/revisions/${p2.firstRevisionId}`)).status).toBe(404);
    expect((await call('POST', `/api/v1/pages/${p1.pageId}/revisions/${p2.firstRevisionId}/restore`, { body: { expectedRevision: 1 } })).status).toBe(404);
  });

  it('restore creates a new revision and keeps history; reset targets published/first/explicit', async () => {
    const p = await newPage();
    const base = `/api/v1/pages/${p.pageId}`;
    await act(p.pageId, 1, [add(p.rootId, 'heading')]); // r2
    await act(p.pageId, 2, [add(p.rootId, 'text')]); // r3
    const restored = await call('POST', `${base}/revisions/${p.firstRevisionId}/restore`, { body: { expectedRevision: 3 } });
    expect(restored.body.data).toMatchObject({ revision: 4, restoredFromRevision: 1 });
    expect((await call('GET', `${base}/document`)).body.data.root.children).toHaveLength(0);
    expect((await call('GET', `${base}/revisions?limit=100`)).body.data.items).toHaveLength(4);
    expect((await call('GET', `${base}/revisions`)).body.data.items[0].source).toBe('RESTORE');
    expect(errOf(await call('POST', `${base}/revisions/${p.firstRevisionId}/restore`, { body: { expectedRevision: 3 } }))).toBe('REVISION_CONFLICT');
    expect((await call('POST', `${base}/revisions/${p.firstRevisionId}/restore`, { body: {} })).status).toBe(400);
    expect((await call('POST', `${base}/revisions/${p.firstRevisionId}/restore`, { body: { expectedRevision: 4 }, token: tok({ scopes: ['document:read', 'document:write'] }) })).status).toBe(403);

    // reset: explicit revision, then publish rev, then reset -> published, never published -> revision 1
    expect((await call('POST', `${base}/document/reset`, { body: { expectedRevision: 4, revisionNo: 2 } })).body.data.restoredFromRevision).toBe(2); // r5 = r2
    expect((await call('POST', `${base}/publish`, { body: { revisionNo: 3 } })).body.data.publishedRevision).toBe(3);
    expect((await call('POST', `${base}/document/reset`, { body: { expectedRevision: 5 } })).body.data.restoredFromRevision).toBe(3); // published
    expect((await call('POST', `${base}/document/reset`, { body: { expectedRevision: 6, revisionNo: 99 } })).status).toBe(404);
    const q = await newPage();
    await act(q.pageId, 1, [add(q.rootId, 'text')]);
    expect((await call('POST', `/api/v1/pages/${q.pageId}/document/reset`, { body: { expectedRevision: 2 } })).body.data.restoredFromRevision).toBe(1);
  });

  it('publish: by draft or revisionNo; failures never move the published pointer', async () => {
    const p = await newPage();
    const base = `/api/v1/pages/${p.pageId}`;
    await act(p.pageId, 1, [add(p.rootId, 'heading')]);
    expect(errOf(await call('POST', `${base}/publish`, { body: {} }))).toBe('BAD_REQUEST');
    expect(errOf(await call('POST', `${base}/publish`, { body: { expectedRevision: 1 } }))).toBe('REVISION_CONFLICT');
    expect((await call('POST', `${base}/publish`, { body: { revisionNo: 99 } })).status).toBe(404);
    expect((await call('GET', `${base}/document`)).body.data.publishedRevision).toBeNull();
    expect((await call('POST', `${base}/publish`, { body: { expectedRevision: 2 } })).body.data.publishedRevision).toBe(2);
    await act(p.pageId, 2, [add(p.rootId, 'text')]);
    expect((await call('POST', `${base}/publish`, { body: { expectedRevision: 1 } })).status).toBe(409);
    const d = (await call('GET', `${base}/document`)).body.data;
    expect([d.revision, d.publishedRevision]).toEqual([3, 2]); // draft moved on, published unchanged
    const list = (await call('GET', `${base}/revisions`)).body.data.items;
    expect(list.find((i: any) => i.isPublished).revision).toBe(2);
    expect((await call('POST', `${base}/publish`, { body: { expectedRevision: 3 }, token: tok({ scopes: ['document:read', 'document:write'] }) })).status).toBe(403);
  });
});

describe('locks', () => {
  it('acquire / renew / conflict / release / expiry', async () => {
    const p = await newPage();
    const base = `/api/v1/pages/${p.pageId}/locks`;
    expect((await call('GET', base)).body.data.lock).toBeNull();
    const a = await call('POST', base, { body: { ttlSeconds: 60 } });
    expect(a.status).toBe(200);
    const lockId = a.body.data.lock.lockId;
    expect(a.body.data.lock).toMatchObject({ heldByMe: true, actorId: '4001' });
    expect((await call('POST', base, { body: {} })).body.data.lock.lockId).toBe(lockId); // renew keeps id
    expect((await call('GET', base, { token: B })).body.data.lock.heldByMe).toBe(false);
    const b = await call('POST', base, { token: B, body: {} });
    expect([b.status, errOf(b)]).toEqual([423, 'DOCUMENT_LOCKED']);
    const edit = await act(p.pageId, 1, [add(p.rootId, 'text')], { token: B });
    expect([edit.status, errOf(edit)]).toEqual([423, 'DOCUMENT_LOCKED']);
    expect((await act(p.pageId, 1, [add(p.rootId, 'text')])).status).toBe(200); // holder may edit
    expect((await call('DELETE', `${base}/${lockId}`, { token: B })).status).toBe(404); // not the owner
    expect((await call('POST', base, { body: { ttlSeconds: 1 } })).status).toBe(400);
    expect((await call('POST', base, { body: { ttlSeconds: 'x' } })).status).toBe(400);
    const rel = await call('DELETE', `${base}/${lockId}`);
    expect([rel.status, rel.body.data]).toEqual([200, { released: true }]);
    expect((await call('DELETE', `${base}/${lockId}`)).status).toBe(404);
    expect((await call('POST', base, { token: B, body: { ttlSeconds: 5 } })).status).toBe(200);
    expect((await call('POST', base, { body: {} })).status).toBe(423);
    await sleep(5500);
    expect((await call('GET', base)).body.data.lock).toBeNull(); // expired
    expect((await call('POST', base, { body: {} })).status).toBe(200); // A can take it over
  });
});

describe('duplicate', () => {
  it('copies the draft with fresh ids to a new page', async () => {
    const p = await newPage();
    await act(p.pageId, 1, [add(p.rootId, 'hero')]);
    const target = uniq();
    const r = await call('POST', `/api/v1/pages/${p.pageId}/document/duplicate`, { body: { targetPageId: target } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ pageId: target, revision: 1, duplicatedFromPageId: p.pageId });
    const src = (await call('GET', `/api/v1/pages/${p.pageId}/document`)).body.data.root;
    const dst = (await call('GET', `/api/v1/pages/${target}/document`)).body.data;
    expect(dst.root.children).toHaveLength(1);
    expect(dst.root.id).not.toBe(src.id);
    expect(dst.root.children[0].id).not.toBe(src.children[0].id);
    expect(errOf(await call('POST', `/api/v1/pages/${p.pageId}/document/duplicate`, { body: { targetPageId: target } }))).toBe('DOCUMENT_EXISTS');
    for (const bad of ['abc', '0', '9223372036854775808', 5 as unknown]) {
      expect((await call('POST', `/api/v1/pages/${p.pageId}/document/duplicate`, { body: { targetPageId: bad } })).status, String(bad)).toBeGreaterThanOrEqual(400);
    }
    expect((await call('POST', `/api/v1/pages/${p.pageId}/document/duplicate`, { body: { targetPageId: uniq() }, token: tok({ tenant: '1002' }) })).status).toBe(404);
  });
});

describe('tenant isolation', () => {
  it('another tenant / organization / workspace gets 404 on every endpoint', async () => {
    const p = await newPage();
    const hero = (await act(p.pageId, 1, [add(p.rootId, 'hero')])).body.data.results[0].createdNodeIds[0];
    const base = `/api/v1/pages/${p.pageId}`;
    const probes: Array<[string, string, unknown?]> = [
      ['GET', `${base}/document`],
      ['GET', `${base}/document?revision=1`],
      ['POST', `${base}/actions`, { expectedRevision: 2, actions: [{ type: 'HIDE_NODE', nodeId: hero }] }],
      ['POST', `${base}/document/validate`, {}],
      ['POST', `${base}/document/duplicate`, { targetPageId: uniq() }],
      ['POST', `${base}/document/reset`, { expectedRevision: 2 }],
      ['POST', `${base}/publish`, { expectedRevision: 2 }],
      ['GET', `${base}/revisions`],
      ['GET', `${base}/revisions/compare?from=1&to=2`],
      ['GET', `${base}/revisions/${p.firstRevisionId}`],
      ['POST', `${base}/revisions/${p.firstRevisionId}/restore`, { expectedRevision: 2 }],
      ['GET', `${base}/locks`],
      ['POST', `${base}/locks`, {}],
      ['DELETE', `${base}/locks/1`],
    ];
    const outsiders = { tenant: tok({ tenant: '1002' }), org: tok({ org: '2002' }), workspace: tok({ ws: '3002' }) };
    for (const [who, token] of Object.entries(outsiders)) {
      for (const [m, path, body] of probes) {
        const r = await call(m, path, { token, body });
        expect([r.status, errOf(r)], `${who} ${m} ${path}`).toEqual([404, 'RESOURCE_NOT_FOUND']);
      }
    }
    expect((await call('GET', `${base}/document`)).body.data.revision).toBe(2); // untouched
  });

  it('permissions are enforced per endpoint (read-only token)', async () => {
    const p = await newPage();
    const ro = tok({ scopes: ['document:read'] });
    const base = `/api/v1/pages/${p.pageId}`;
    for (const path of ['/document', '/revisions', `/revisions/${p.firstRevisionId}`, '/revisions/compare?from=1&to=1', '/locks']) {
      expect((await call('GET', base + path, { token: ro })).status, path).toBe(200);
    }
    const writes: Array<[string, string, unknown]> = [
      ['POST', '/actions', { expectedRevision: 1, actions: [add(p.rootId, 'text')] }],
      ['POST', '/document/validate', {}],
      ['POST', '/document/duplicate', { targetPageId: uniq() }],
      ['POST', '/document/reset', { expectedRevision: 1 }],
      ['POST', '/publish', { expectedRevision: 1 }],
      ['POST', `/revisions/${p.firstRevisionId}/restore`, { expectedRevision: 1 }],
      ['POST', '/locks', {}],
      ['DELETE', '/locks/1', undefined],
    ];
    for (const [m, path, body] of writes) expect((await call(m, base + path, { token: ro, body })).status, `${m} ${path}`).toBe(403);
    expect((await call('GET', base + '/document', { token: tok({ scopes: [] }) })).status).toBe(403);
  });
});

describe('references, outbox, BIGINT discipline', () => {
  it('tracks media references and emits the right outbox events', async () => {
    const p = await newPage();
    const hero = (await act(p.pageId, 1, [add(p.rootId, 'hero')])).body.data.results[0].createdNodeIds[0];
    await act(p.pageId, 2, [{ type: 'REPLACE_MEDIA', nodeId: hero, assetId: '9007199254740993' }]);
    const refs = await pool.query('SELECT ref_type, ref_key, node_id FROM document_references WHERE document_id = $1', [p.documentId]);
    expect(refs.rows).toEqual([{ ref_type: 'media', ref_key: '9007199254740993', node_id: hero }]);
    await act(p.pageId, 3, [{ type: 'UPDATE_PROPS', nodeId: hero, patch: { mediaAssetId: null } }]);
    expect((await pool.query('SELECT 1 FROM document_references WHERE document_id = $1', [p.documentId])).rowCount).toBe(0);
    await call('POST', `/api/v1/pages/${p.pageId}/publish`, { body: { expectedRevision: 4 } });

    const seen: OutboxEvent[] = [];
    for (let i = 0; i < 50 && (await drainOutbox(async (e) => void seen.push(e), 200)) > 0; i++);
    const mine = (await pool.query('SELECT event_type, status FROM outbox_events WHERE aggregate_id = $1', [p.documentId])).rows;
    const types = mine.map((m) => m.event_type);
    expect(types).toContain('document.created');
    expect(types.filter((t) => t === 'document.changed')).toHaveLength(3);
    expect(types.filter((t) => t === 'document.revision.created')).toHaveLength(3);
    expect(types.filter((t) => t === 'media.reference.changed')).toHaveLength(2); // added, then removed
    expect(types).toContain('page.published');
    expect(mine.every((m) => m.status === 'PUBLISHED')).toBe(true);
    expect(seen.some((e) => e.aggregate_id === p.documentId)).toBe(true);
  });

  it('failed publishers are retried, then parked as FAILED after repeated errors', async () => {
    const p = await newPage();
    for (let i = 0; i < 50 && (await drainOutbox(async () => undefined, 200)) > 0; i++);
    await act(p.pageId, 1, [add(p.rootId, 'text')]);
    await drainOutbox(async () => { throw new Error('broker down'); }, 200);
    const row = (await pool.query(`SELECT status, attempts, last_error FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'document.changed'`, [p.documentId])).rows[0];
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'broker down' });
    for (let i = 0; i < 10; i++) await drainOutbox(async () => { throw new Error('broker down'); }, 200);
    const parked = (await pool.query(`SELECT status FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'document.changed'`, [p.documentId])).rows[0];
    expect(parked.status).toBe('FAILED');
    await pool.query(`UPDATE outbox_events SET status = 'PUBLISHED' WHERE aggregate_id = $1`, [p.documentId]);
  });

  it('no JSON response ever contains a numeric id field; revisions stay immutable in the DB', async () => {
    const p = await newPage();
    await act(p.pageId, 1, [add(p.rootId, 'hero')]);
    const bodies = [
      (await call('GET', `/api/v1/pages/${p.pageId}/document`)).body,
      (await call('GET', `/api/v1/pages/${p.pageId}/revisions`)).body,
      (await call('POST', `/api/v1/pages/${p.pageId}/locks`, { body: {} })).body,
    ];
    const bad: string[] = [];
    const walk = (v: any, path: string) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
        if (/(^id$|Id$)/.test(k) && typeof x === 'number') bad.push(`${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
    };
    bodies.forEach((b, i) => walk(b, `body${i}`));
    expect(bad).toEqual([]);
    await expect(pool.query('UPDATE document_revisions SET source = $1 WHERE document_id = $2', ['AI', p.documentId])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM document_revisions WHERE document_id = $1', [p.documentId])).rejects.toThrow(/immutable/);
  });
});
