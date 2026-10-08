// Generates the Postman files in ./postman:
//   Document-API.postman_collection.json            every request returns 200 OK (happy paths)
//   Document-API.local.postman_environment.json     environment (git-ignored; jwtSecret filled from .env)
// Run: npm run postman:build
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../postman');

// ---- shared sandbox snippet: signs an HS256 JWT with CryptoJS (built into Postman/newman) -------
const SIGN_FN = `
const CJS = (typeof CryptoJS !== 'undefined') ? CryptoJS : require('crypto-js');
function b64url(wa){return CJS.enc.Base64.stringify(wa).replace(/=+$/,'').replace(/\\+/g,'-').replace(/\\//g,'_');}
function signToken(o){
  const secret = pm.variables.get('jwtSecret');
  if(!secret){ return null; }
  const now = Math.floor(Date.now()/1000);
  const payload = {
    sub: String(o.actorId || pm.variables.get('actorId')),
    tenantId: String(o.tenantId || pm.variables.get('tenantId')),
    organizationId: String(pm.variables.get('organizationId')),
    workspaceId: String(pm.variables.get('workspaceId')),
    scopes: o.scopes || ['document:*'],
    roles: ['editor'],
    iat: now, exp: now + 3600
  };
  if(pm.variables.get('jwtIssuer')) payload.iss = pm.variables.get('jwtIssuer');
  if(pm.variables.get('jwtAudience')) payload.aud = pm.variables.get('jwtAudience');
  const h = b64url(CJS.enc.Utf8.parse(JSON.stringify({alg:'HS256',typ:'JWT'})));
  const p = b64url(CJS.enc.Utf8.parse(JSON.stringify(payload)));
  const s = b64url(CJS.HmacSHA256(h + '.' + p, secret));
  return h + '.' + p + '.' + s;
}`.trim();

const collectionPre = `${SIGN_FN}
// 1) Authentication: Bearer <accessToken>. accessToken is a LOCAL variable, so a blank 'token' in your Postman
//    environment can never shadow it. Preferred: set jwtSecret and the token is signed here for every request.
//    Fallback: paste a ready-made JWT (npm run token) into the 'token' variable and leave jwtSecret empty.
pm.variables.unset('accessToken');
const signed = signToken({});
const manual = pm.variables.get('token');
if (signed) pm.variables.set('accessToken', signed);
else if (manual) pm.variables.set('accessToken', manual);
else if (!(pm.request.auth && pm.request.auth.type === 'noauth') && pm.request.url.getPath().startsWith('/api/')) {
  const env = pm.environment.name;
  throw new Error('No credentials (jwtSecret is empty). ' + (env ? 'Active environment: "' + env + '" - open it and paste JWT_SECRET from .env into jwtSecret, then Save.' : 'NO ENVIRONMENT IS SELECTED - choose "Document API - Local" in the top-right environment dropdown.') + ' Alternative: paste a JWT (npm run token) into the token variable.');
}
// 2) Fail early with a clear message when a request is run out of order.
if (!pm.info.requestName.startsWith('Create document')) {
  const raw = pm.request.url.toString() + ' ' + ((pm.request.body && pm.request.body.raw) || '');
  const names = ['pageId','dupPageId','rootId','heroId','headingId','buttonId','sectionId','dupNodeId','wrapperId','firstRevisionId','revision','lockId'];
  const missing = names.filter(n => raw.includes('{{' + n + '}}') && !pm.variables.get(n));
  if (missing.length) throw new Error('Missing variable(s): ' + missing.join(', ') + '. Run the collection in order with the Collection Runner (first request: "Create document").');
}
`;

const asUser = (opts) => `${SIGN_FN}
const t = signToken(${JSON.stringify(opts)});
if (!t) { throw new Error('Set the jwtSecret environment variable (value of JWT_SECRET in .env) to run this request'); }
pm.variables.set('accessToken', t);
`;

// ---- builders ---------------------------------------------------------------------------------
const lines = (s) => s.trim().split('\n');
const ev = (listen, script) => ({ listen, script: { type: 'text/javascript', exec: lines(script) } });

function item(name, method, p, { body, query, headers = [], pre, test, auth, description } = {}) {
  const raw = `{{baseUrl}}${p}${query ? '?' + query.map((q) => `${q.key}=${q.value}`).join('&') : ''}`;
  const r = {
    method,
    header: [{ key: 'Accept', value: 'application/json' }, ...(body !== undefined ? [{ key: 'Content-Type', value: 'application/json' }] : []), ...headers],
    url: { raw, host: ['{{baseUrl}}'], path: p.split('/').filter(Boolean), ...(query ? { query } : {}) },
    ...(description ? { description } : {}),
  };
  if (body !== undefined) r.body = { mode: 'raw', raw: typeof body === 'string' ? body : JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } };
  if (auth) r.auth = auth;
  return { name, event: [...(pre ? [ev('prerequest', pre)] : []), ...(test ? [ev('test', test)] : [])], request: r };
}

const folder = (name, items, description) => ({ name, item: items, ...(description ? { description } : {}) });

const status = (n) => `pm.test('HTTP ${n} OK', () => pm.response.to.have.status(${n}));`;
const ok200 = (extra = '') => `${status(200)}
pm.test('success envelope', () => {
  const j = pm.response.json();
  pm.expect(j.success).to.eql(true);
  pm.expect(j.meta.requestId).to.be.a('string');
});
${extra}`;
const errCode = (n, code) => `pm.test('HTTP ${n}', () => pm.response.to.have.status(${n}));
pm.test('error.code is ${code}', () => {
  const j = pm.response.json();
  pm.expect(j.success).to.eql(false);
  pm.expect(j.error.code).to.eql('${code}');
  pm.expect(j.requestId).to.be.a('string');
});`;

const saveRevision = `const j = pm.response.json();
pm.test('revision incremented by exactly 1', () => {
  pm.expect(j.data.revision).to.eql(Number(pm.collectionVariables.get('revision')) + 1);
});
pm.collectionVariables.set('revision', String(j.data.revision));
pm.test('revision metadata ids are strings (BIGINT-safe)', () => {
  pm.expect(j.data.revisionId).to.be.a('string');
  pm.expect(j.data.actionBatchId).to.be.a('string');
});`;

const bodyWith = (obj, key = 'revision') => JSON.stringify({ expectedRevision: '__REV__', ...obj }, null, 2).replace('"__REV__"', `{{${key}}}`);
const act = (acts, key = 'revision') => bodyWith({ actions: acts }, key);
const post = (name, acts, test, pre, headers = [{ key: 'Idempotency-Key', value: '{{$guid}}' }]) => item(name, 'POST', '/api/v1/pages/{{pageId}}/actions', { body: act(acts), test, pre, headers });
const okBatch = (extra = '') => `${ok200()}\n${saveRevision}\n${extra}`;
const noAuth = { type: 'noauth' };
const newPageIds = `// new unique BIGINT page ids on every run (strings; never a JS Number)
pm.collectionVariables.set('pageId', String(Date.now()) + String(Math.floor(Math.random()*900)+100));
pm.collectionVariables.set('dupPageId', String(Date.now()) + String(Math.floor(Math.random()*900)+100));`;

const createDoc = (name = 'Create document for page') =>
  item(name, 'POST', '/api/v1/pages/{{pageId}}/document', {
    body: {},
    pre: newPageIds,
    test: `${ok200()}
const j = pm.response.json();
pm.test('document created at revision 1 with a page root', () => {
  pm.expect(j.data.revision).to.eql(1);
  pm.expect(j.data.documentId).to.be.a('string');
  pm.expect(j.data.root.type).to.eql('page');
  pm.expect(j.data.root.id).to.be.a('string');
});
pm.collectionVariables.set('documentId', j.data.documentId);
pm.collectionVariables.set('rootId', j.data.root.id);
pm.collectionVariables.set('firstRevisionId', j.data.revisionId);
pm.collectionVariables.set('revision', '1');`,
  });

const VARS = ['pageId', 'dupPageId', 'documentId', 'rootId', 'heroId', 'headingId', 'buttonId', 'sectionId', 'dupNodeId', 'wrapperId', 'firstRevisionId', 'revision', 'idemKey', 'idemExpected', 'idemRevisionId', 'lockId'];

function makeCollection(name, description, items) {
  return {
    info: { name, description, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
    event: [ev('prerequest', collectionPre)],
    variable: [
      { key: 'baseUrl', value: 'http://localhost:3000' },
      { key: 'jwtSecret', value: '' },
      { key: 'jwtIssuer', value: '' },
      { key: 'jwtAudience', value: '' },
      { key: 'tenantId', value: '1001' },
      { key: 'organizationId', value: '2001' },
      { key: 'workspaceId', value: '3001' },
      { key: 'actorId', value: '4001' },
      { key: 'token', value: '' },
      ...VARS.map((key) => ({ key, value: '' })),
    ],
    item: items,
  };
}

const SETUP_NOTE =
  'Setup: import the environment file, set `jwtSecret` to the JWT_SECRET value from your .env (or paste a token from `npm run token` into the `token` collection variable and leave jwtSecret empty). Never commit the secret. Run folders top-to-bottom with the Collection Runner: later requests reuse ids saved by earlier ones.';

// =================================================================================================
// MAIN COLLECTION - every request returns 200 OK
// =================================================================================================
const health = folder('00 Health & registry', [
  item('Health', 'GET', '/health', { auth: noAuth, test: `${status(200)}\npm.test('status ok', () => pm.expect(pm.response.json().status).to.eql('ok'));` }),
  item('Readiness (database)', 'GET', '/health/ready', { auth: noAuth, test: `${status(200)}\npm.test('ready', () => pm.expect(pm.response.json().status).to.eql('ready'));` }),
  item('Verify Bearer token (component registry)', 'GET', '/api/v1/components', {
    test: `${status(200)}
const types = pm.response.json().data.map(c => c.type);
pm.test('registry contains hero, heading, button', () => pm.expect(types).to.include.members(['hero','heading','button']));`,
  }),
]);

const lifecycle = folder('01 Document lifecycle', [
  createDoc(),
  item('Get current draft', 'GET', '/api/v1/pages/{{pageId}}/document', {
    test: `${ok200()}
const j = pm.response.json();
pm.test('ids are strings and match', () => {
  pm.expect(j.data.documentId).to.eql(pm.collectionVariables.get('documentId'));
  pm.expect(j.data.pageId).to.eql(pm.collectionVariables.get('pageId'));
  pm.expect(j.data.revision).to.eql(1);
  pm.expect(j.data.schemaVersion).to.eql(1);
});`,
  }),
]);

const builder = folder('02 Builder Actions', [
  post('ADD_NODE hero under page', [{ type: 'ADD_NODE', parentId: '{{rootId}}', componentType: 'hero', props: { title: 'Grow your business', description: 'Build your website with TriostackOne' } }], okBatch(`pm.collectionVariables.set('heroId', j.data.results[0].createdNodeIds[0]);`)),
  post('ADD_NODE heading inside hero', [{ type: 'ADD_NODE', parentId: '{{heroId}}', componentType: 'heading' }], okBatch(`pm.collectionVariables.set('headingId', j.data.results[0].createdNodeIds[0]);`)),
  post('ADD_NODE button inside hero', [{ type: 'ADD_NODE', parentId: '{{heroId}}', componentType: 'button', props: { label: 'Get started' } }], okBatch(`pm.collectionVariables.set('buttonId', j.data.results[0].createdNodeIds[0]);`)),
  post('UPDATE_PROPS heading text', [{ type: 'UPDATE_PROPS', nodeId: '{{headingId}}', patch: { text: 'Welcome to TriostackOne' } }], okBatch()),
  post('UPDATE_STYLES hero', [{ type: 'UPDATE_STYLES', nodeId: '{{heroId}}', patch: { backgroundColor: '#111827', paddingTop: '80px' } }], okBatch()),
  post('UPDATE_RESPONSIVE hero (mobile)', [{ type: 'UPDATE_RESPONSIVE', nodeId: '{{heroId}}', device: 'mobile', patch: { paddingTop: '40px' } }], okBatch()),
  post('UPDATE_VISIBILITY hero (hide on tablet)', [{ type: 'UPDATE_VISIBILITY', nodeId: '{{heroId}}', patch: { tablet: false } }], okBatch()),
  post('HIDE_NODE / SHOW_NODE button', [{ type: 'HIDE_NODE', nodeId: '{{buttonId}}', devices: ['mobile'] }, { type: 'SHOW_NODE', nodeId: '{{buttonId}}', devices: ['mobile'] }], okBatch()),
  post('UPDATE_LINK button', [{ type: 'UPDATE_LINK', nodeId: '{{buttonId}}', link: { href: 'https://example.com/signup', target: '_blank' } }], okBatch()),
  post('REPLACE_MEDIA hero (asset id above 2^53)', [{ type: 'REPLACE_MEDIA', nodeId: '{{heroId}}', assetId: '9007199254740993' }], okBatch()),
  item('Verify state after edits', 'GET', '/api/v1/pages/{{pageId}}/document', {
    test: `${ok200()}
const hero = pm.response.json().data.root.children[0];
pm.test('hero props / styles / responsive / visibility persisted', () => {
  pm.expect(hero.props.title).to.eql('Grow your business');
  pm.expect(hero.styles).to.include({ backgroundColor: '#111827', paddingTop: '80px' });
  pm.expect(hero.responsive.mobile).to.eql({ paddingTop: '40px' });
  pm.expect(hero.visibility.tablet).to.eql(false);
  pm.expect(hero.visibility.desktop).to.eql(true);
});
pm.test('BIGINT above 2^53 round-trips exactly as a string', () => pm.expect(hero.props.mediaAssetId).to.eql('9007199254740993'));
pm.test('only the intended heading changed', () => {
  pm.expect(hero.children[0].props.text).to.eql('Welcome to TriostackOne');
  pm.expect(hero.children[1].props.label).to.eql('Get started');
  pm.expect(hero.children[1].props.link.rel).to.eql('noopener noreferrer');
});`,
  }),
  post('DUPLICATE_NODE button', [{ type: 'DUPLICATE_NODE', nodeId: '{{buttonId}}' }], okBatch(`pm.collectionVariables.set('dupNodeId', j.data.results[0].createdNodeIds[0]);
pm.test('duplicate got a new id', () => pm.expect(j.data.results[0].createdNodeIds[0]).to.not.eql(pm.collectionVariables.get('buttonId')));`)),
  post('DELETE_NODE duplicated button', [{ type: 'DELETE_NODE', nodeId: '{{dupNodeId}}' }], okBatch()),
  post('MOVE_NODE button to page root', [{ type: 'MOVE_NODE', nodeId: '{{buttonId}}', newParentId: '{{rootId}}', index: 0 }], okBatch()),
  post(
    'Multi-action batch: ADD section + INSERT_BLOCK + APPLY_THEME',
    [
      { type: 'ADD_NODE', parentId: '{{rootId}}', componentType: 'section', styles: { paddingTop: '48px' } },
      { type: 'INSERT_BLOCK', parentId: '{{rootId}}', block: { type: 'testimonial', props: { quote: 'Great product', author: 'A. Customer', rating: 5 }, children: [{ type: 'heading', props: { text: 'Loved by teams' } }] } },
      { type: 'APPLY_THEME', tokens: { primary: '#111827', accent: '#2563eb' } },
    ],
    okBatch(`pm.test('three results, ids are strings', () => { pm.expect(j.data.results).to.have.length(3); pm.expect(j.data.results[1].createdNodeIds[0]).to.be.a('string'); });
pm.collectionVariables.set('sectionId', j.data.results[0].createdNodeIds[0]);`),
  ),
  post('WRAP_NODE button in container', [{ type: 'WRAP_NODE', nodeId: '{{buttonId}}', wrapperType: 'container' }], okBatch(`pm.collectionVariables.set('wrapperId', j.data.results[0].createdNodeIds[0]);`)),
  post('UNWRAP_NODE container', [{ type: 'UNWRAP_NODE', nodeId: '{{wrapperId}}' }], okBatch()),
  post('LOCK_NODE hero', [{ type: 'LOCK_NODE', nodeId: '{{heroId}}' }], okBatch()),
  post('UNLOCK_NODE hero', [{ type: 'UNLOCK_NODE', nodeId: '{{heroId}}' }], okBatch()),
  item('AI-sourced edit (token with document:ai scope)', 'POST', '/api/v1/pages/{{pageId}}/actions', {
    body: bodyWith({ source: 'AI', actions: [{ type: 'UPDATE_PROPS', nodeId: '{{headingId}}', patch: { text: 'Written by AI' } }] }),
    pre: asUser({ scopes: ['document:read', 'document:write', 'document:ai'] }),
    test: okBatch(),
  }),
]);

const validate = folder('03 Validate (dry run)', [
  item('Validate actions (valid)', 'POST', '/api/v1/pages/{{pageId}}/document/validate', {
    body: bodyWith({ actions: [{ type: 'UPDATE_PROPS', nodeId: '{{headingId}}', patch: { text: 'Preview only' } }] }),
    test: `${ok200()}
pm.test('valid and nothing persisted', () => { const d = pm.response.json().data; pm.expect(d.valid).to.eql(true); pm.expect(d.revision).to.eql(Number(pm.collectionVariables.get('revision'))); });`,
  }),
  item('Validate actions (invalid -> reported in body, still 200)', 'POST', '/api/v1/pages/{{pageId}}/document/validate', {
    body: { actions: [{ type: 'ADD_NODE', parentId: '{{heroId}}', componentType: 'hero' }] },
    test: `${ok200()}
pm.test('valid=false with the error code', () => { const d = pm.response.json().data; pm.expect(d.valid).to.eql(false); pm.expect(d.error.code).to.eql('INVALID_TREE'); });`,
  }),
  item('Validate stored draft', 'POST', '/api/v1/pages/{{pageId}}/document/validate', {
    body: {},
    test: `${ok200()}\npm.test('draft is valid', () => pm.expect(pm.response.json().data.valid).to.eql(true));`,
  }),
]);

const idemBody = JSON.stringify({ expectedRevision: '__REV__', actions: [{ type: 'UPDATE_PROPS', nodeId: '{{headingId}}', patch: { text: 'Idempotent title' } }] }, null, 2).replace('"__REV__"', '{{idemExpected}}');
const idem = folder('04 Idempotency', [
  item('First request with Idempotency-Key', 'POST', '/api/v1/pages/{{pageId}}/actions', {
    headers: [{ key: 'Idempotency-Key', value: '{{idemKey}}' }],
    body: idemBody,
    pre: `pm.collectionVariables.set('idemExpected', pm.collectionVariables.get('revision'));
pm.collectionVariables.set('idemKey', 'save-' + pm.collectionVariables.get('pageId') + '-' + Date.now());`,
    test: `${okBatch()}
pm.test('not a replay', () => pm.expect(pm.response.headers.has('Idempotent-Replayed')).to.eql(false));
pm.collectionVariables.set('idemRevisionId', j.data.revisionId);`,
  }),
  item('Retry same key + same body -> replayed 200', 'POST', '/api/v1/pages/{{pageId}}/actions', {
    headers: [{ key: 'Idempotency-Key', value: '{{idemKey}}' }],
    body: idemBody,
    test: `${ok200()}
const j = pm.response.json();
pm.test('replayed: same revisionId, header set, no new revision', () => {
  pm.expect(pm.response.headers.get('Idempotent-Replayed')).to.eql('true');
  pm.expect(j.data.revisionId).to.eql(pm.collectionVariables.get('idemRevisionId'));
  pm.expect(j.data.revision).to.eql(Number(pm.collectionVariables.get('revision')));
});`,
  }),
]);

const revisions = folder('05 Revisions', [
  item('List revisions', 'GET', '/api/v1/pages/{{pageId}}/revisions', {
    query: [{ key: 'limit', value: '50' }],
    test: `${ok200()}
const d = pm.response.json().data;
pm.test('newest first, flags set, ids are strings', () => {
  pm.expect(d.items[0].revision).to.eql(Number(pm.collectionVariables.get('revision')));
  pm.expect(d.items[0].isCurrent).to.eql(true);
  pm.expect(d.items[0].revisionId).to.be.a('string');
  pm.expect(d.items[d.items.length - 1].revision).to.eql(1);
  pm.expect(d.items[d.items.length - 1].source).to.eql('SYSTEM');
});`,
  }),
  item('Get exact revision by number (1)', 'GET', '/api/v1/pages/{{pageId}}/document', {
    query: [{ key: 'revision', value: '1' }],
    test: `${ok200()}\npm.test('revision 1 is the empty page', () => { const d = pm.response.json().data; pm.expect(d.revision).to.eql(1); pm.expect(d.root.children).to.have.length(0); });`,
  }),
  item('Read revision by id', 'GET', '/api/v1/pages/{{pageId}}/revisions/{{firstRevisionId}}', { test: `${ok200()}\npm.test('is revision 1', () => pm.expect(pm.response.json().data.revision).to.eql(1));` }),
  item('Compare revision 1 -> current (structural)', 'GET', '/api/v1/pages/{{pageId}}/revisions/compare', {
    query: [{ key: 'from', value: '1' }, { key: 'to', value: '{{revision}}' }],
    test: `${ok200()}
pm.test('node-level changes reported', () => {
  const d = pm.response.json().data;
  pm.expect(d.summary.added).to.be.above(0);
  pm.expect(d.changes.some(c => c.kind === 'added' && c.type === 'hero')).to.eql(true);
});`,
  }),
  item('Restore revision 1 (new revision, history kept)', 'POST', '/api/v1/pages/{{pageId}}/revisions/{{firstRevisionId}}/restore', {
    body: '{ "expectedRevision": {{revision}} }',
    test: `${ok200()}
const j = pm.response.json();
pm.test('restore created a NEW revision from revision 1', () => {
  pm.expect(j.data.revision).to.eql(Number(pm.collectionVariables.get('revision')) + 1);
  pm.expect(j.data.restoredFromRevision).to.eql(1);
});
pm.collectionVariables.set('revision', String(j.data.revision));`,
  }),
  item('Draft is empty again, history intact', 'GET', '/api/v1/pages/{{pageId}}/document', {
    test: `${ok200()}\npm.test('draft equals revision 1 content', () => pm.expect(pm.response.json().data.root.children).to.have.length(0));`,
  }),
  item('Reset to revision 2', 'POST', '/api/v1/pages/{{pageId}}/document/reset', {
    body: '{ "expectedRevision": {{revision}}, "revisionNo": 2 }',
    test: `${ok200()}
const j = pm.response.json();
pm.test('reset created a new revision', () => pm.expect(j.data.restoredFromRevision).to.eql(2));
pm.collectionVariables.set('revision', String(j.data.revision));`,
  }),
]);

const publish = folder('06 Publish', [
  item('Publish current draft', 'POST', '/api/v1/pages/{{pageId}}/publish', {
    body: '{ "expectedRevision": {{revision}} }',
    test: `${ok200()}\npm.test('published pointer = current revision', () => pm.expect(pm.response.json().data.publishedRevision).to.eql(Number(pm.collectionVariables.get('revision'))));`,
  }),
  item('Draft shows publishedRevision', 'GET', '/api/v1/pages/{{pageId}}/document', {
    test: `${ok200()}\npm.test('publishedRevision reported', () => pm.expect(pm.response.json().data.publishedRevision).to.eql(Number(pm.collectionVariables.get('revision'))));`,
  }),
]);

const locks = folder('07 Locks', [
  item('Get lock (none yet)', 'GET', '/api/v1/pages/{{pageId}}/locks', { test: `${ok200()}\npm.test('no lock', () => pm.expect(pm.response.json().data.lock).to.eql(null));` }),
  item('Acquire lock', 'POST', '/api/v1/pages/{{pageId}}/locks', {
    body: { ttlSeconds: 120 },
    test: `${ok200()}
const j = pm.response.json();
pm.test('lock held by me', () => { pm.expect(j.data.lock.heldByMe).to.eql(true); pm.expect(j.data.lock.lockId).to.be.a('string'); });
pm.collectionVariables.set('lockId', j.data.lock.lockId);`,
  }),
  item('Get lock', 'GET', '/api/v1/pages/{{pageId}}/locks', { test: `${ok200()}\npm.test('lock present', () => pm.expect(pm.response.json().data.lock.lockId).to.eql(pm.collectionVariables.get('lockId')));` }),
  item('Renew lock (same id)', 'POST', '/api/v1/pages/{{pageId}}/locks', {
    body: { ttlSeconds: 120 },
    test: `${ok200()}\npm.test('same lock id', () => pm.expect(pm.response.json().data.lock.lockId).to.eql(pm.collectionVariables.get('lockId')));`,
  }),
  item('Release lock', 'DELETE', '/api/v1/pages/{{pageId}}/locks/{{lockId}}', { test: `${ok200()}\npm.test('released', () => pm.expect(pm.response.json().data.released).to.eql(true));` }),
  item('Lock is gone', 'GET', '/api/v1/pages/{{pageId}}/locks', { test: `${ok200()}\npm.test('no lock', () => pm.expect(pm.response.json().data.lock).to.eql(null));` }),
]);

const duplicate = folder('08 Duplicate', [
  item('Duplicate document to another page', 'POST', '/api/v1/pages/{{pageId}}/document/duplicate', {
    body: { targetPageId: '{{dupPageId}}' },
    test: `${ok200()}
const j = pm.response.json();
pm.test('new document for target page at revision 1', () => { pm.expect(j.data.pageId).to.eql(pm.collectionVariables.get('dupPageId')); pm.expect(j.data.revision).to.eql(1); });`,
  }),
  item('Copy uses fresh node ids', 'GET', '/api/v1/pages/{{dupPageId}}/document', {
    test: `${ok200()}\npm.test('root id differs from source', () => pm.expect(pm.response.json().data.root.id).to.not.eql(pm.collectionVariables.get('rootId')));`,
  }),
]);

const access = folder('09 Scoped access', [
  item('Read-only token can GET document', 'GET', '/api/v1/pages/{{pageId}}/document', { pre: asUser({ scopes: ['document:read'] }), test: ok200() }),
  item('Read-only token can list revisions', 'GET', '/api/v1/pages/{{pageId}}/revisions', { pre: asUser({ scopes: ['document:read'] }), test: ok200() }),
  item('Publisher token can publish', 'POST', '/api/v1/pages/{{pageId}}/publish', {
    body: '{ "expectedRevision": {{revision}} }',
    pre: asUser({ scopes: ['document:read', 'document:publish'] }),
    test: ok200(),
  }),
]);

const main = makeCollection(
  'TriostackOne - Document API',
  `Document API microservice (Website Builder). Every request in this collection returns 200 OK. Error cases (409/422/403/404...) are covered by the automated test suite (npm test).\n\n${SETUP_NOTE}`,
  [health, lifecycle, builder, validate, idem, revisions, publish, locks, duplicate, access],
);

// =================================================================================================
const environment = {
  id: 'triostackone-document-api-local',
  name: 'Document API - Local',
  values: [
    { key: 'baseUrl', value: 'http://localhost:3000', type: 'default', enabled: true },
    { key: 'jwtSecret', value: '', type: 'secret', enabled: true },
    { key: 'jwtIssuer', value: '', type: 'default', enabled: true },
    { key: 'jwtAudience', value: '', type: 'default', enabled: true },
    { key: 'tenantId', value: '1001', type: 'default', enabled: true },
    { key: 'organizationId', value: '2001', type: 'default', enabled: true },
    { key: 'workspaceId', value: '3001', type: 'default', enabled: true },
    { key: 'actorId', value: '4001', type: 'default', enabled: true },
  ],
  _postman_variable_scope: 'environment',
};

// Local, git-ignored environment (postman/*.local.* is in .gitignore) pre-filled from .env so imports just work.
try {
  const envFile = fs.readFileSync(path.resolve(outDir, '../.env'), 'utf8');
  const fromEnv = (k) => (envFile.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1].trim();
  const keyMap = { jwtSecret: 'JWT_SECRET', jwtIssuer: 'JWT_ISSUER', jwtAudience: 'JWT_AUDIENCE' };
  const local = {
    ...environment,
    id: 'triostackone-document-api-local-secrets',
    name: 'Document API - Local (with secrets, git-ignored)',
    values: environment.values.map((v) => (keyMap[v.key] ? { ...v, type: 'default', value: fromEnv(keyMap[v.key]) } : v)),
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'Document-API.local.postman_environment.json'), JSON.stringify(local, null, 2) + '\n');
} catch {
  // no .env available: write the environment with a blank jwtSecret to fill in manually
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'Document-API.local.postman_environment.json'), JSON.stringify(environment, null, 2) + '\n');
}
fs.mkdirSync(outDir, { recursive: true });
const write = (f, o) => fs.writeFileSync(path.join(outDir, f), JSON.stringify(o, null, 2) + '\n');
write('Document-API.postman_collection.json', main);
console.log('wrote 2 files to postman/ (1 collection + 1 environment)');
