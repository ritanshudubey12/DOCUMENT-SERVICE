import { describe, expect, it } from 'vitest';
import { Snowflake } from '../src/common/ids';
import { bigintReplacer, isBigintId, parseId } from '../src/common/bigint';
import { AppError } from '../src/common/errors';
import { builderActionSchema, type BuilderAction } from '../src/domain/actions';
import { applyActions, createEmptyDocument } from '../src/domain/reducer';
import { diffDocuments } from '../src/domain/diff';
import { collectReferences, validateDocument } from '../src/domain/validate-document';
import type { DocumentJson } from '../src/domain/types';

const sf = new Snowflake(7n);
const deps = { newId: () => sf.next(), maxDepth: 32 };
const limits = { maxNodes: 5000, maxDepth: 32, maxBytes: 2_000_000 };
const PAGE = '700001';

const act = (a: unknown) => builderActionSchema.parse(a) as BuilderAction;
const run = (doc: DocumentJson, ...actions: unknown[]) => applyActions(doc, actions.map(act), deps);
const fresh = () => createEmptyDocument(PAGE, deps.newId);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
};

function withHero() {
  const d0 = fresh();
  const r = run(d0, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'hero', props: { title: 'Hi' } });
  return { doc: r.doc, heroId: r.results[0].createdNodeIds[0] };
}

describe('BIGINT handling', () => {
  it('generates unique, increasing ids that fit in signed 64 bits', () => {
    const ids = Array.from({ length: 20000 }, () => sf.next());
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) expect(BigInt(ids[i]) > BigInt(ids[i - 1])).toBe(true);
    expect(ids.every((id) => BigInt(id) < 2n ** 63n)).toBe(true);
  });
  it('accepts only canonical 64-bit decimal strings', () => {
    expect(isBigintId('9007199254740993')).toBe(true);
    expect(isBigintId('9223372036854775807')).toBe(true);
    for (const bad of ['9223372036854775808', '0', '-1', '01', '1.5', 'abc', '', 12 as unknown]) expect(isBigintId(bad)).toBe(false);
    expect(() => parseId('abc', 'pageId')).toThrow();
  });
  it('keeps ids above 2^53 exact (a Number would corrupt them)', () => {
    expect(String(Number('9007199254740993'))).not.toBe('9007199254740993');
    expect(JSON.stringify({ id: 9007199254740993n }, bigintReplacer)).toBe('{"id":"9007199254740993"}');
  });
});

describe('Builder Actions', () => {
  it('ADD_NODE adds a registered component with defaults and does not mutate the input', () => {
    const d0 = fresh();
    const before = JSON.stringify(d0);
    const { doc, results } = run(d0, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'heading' });
    expect(JSON.stringify(d0)).toBe(before);
    expect(doc.root.children).toHaveLength(1);
    expect(doc.root.children[0].props).toMatchObject({ text: 'Heading', level: 2 });
    expect(results[0].createdNodeIds[0]).toBe(doc.root.children[0].id);
    validateDocument(doc, limits, PAGE);
  });

  it('rejects unknown components and forbidden children', () => {
    const { doc, heroId } = withHero();
    expect(code(() => run(doc, { type: 'ADD_NODE', parentId: doc.root.id, componentType: 'marquee' }))).toBe('COMPONENT_NOT_FOUND');
    expect(code(() => run(doc, { type: 'ADD_NODE', parentId: heroId, componentType: 'hero' }))).toBe('INVALID_TREE');
    expect(code(() => run(doc, { type: 'ADD_NODE', parentId: doc.root.id, componentType: 'page' }))).toBe('INVALID_TREE');
  });

  it('rejects styles the component has no capability for', () => {
    const d0 = fresh();
    const { doc } = run(d0, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'button' });
    const buttonId = doc.root.children[0].id;
    expect(code(() => run(doc, { type: 'UPDATE_STYLES', nodeId: buttonId, patch: { animation: 'fade-in' } }))).toBe('CAPABILITY_NOT_SUPPORTED');
    expect(code(() => run(doc, { type: 'UPDATE_STYLES', nodeId: buttonId, patch: { zIndex: '9' } }))).toBe('ACTION_INVALID');
  });

  it('changing a heading updates only the intended node', () => {
    const d0 = fresh();
    const a = run(d0, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'heading' }, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'heading' });
    const [h1, h2] = a.doc.root.children.map((c) => c.id);
    const { doc } = run(a.doc, { type: 'UPDATE_PROPS', nodeId: h1, patch: { text: 'Welcome' } });
    expect(doc.root.children[0].props.text).toBe('Welcome');
    expect(doc.root.children[1]).toEqual(a.doc.root.children[1]);
    expect(doc.root.children[1].id).toBe(h2);
  });

  it('keeps mobile overrides isolated from desktop styles', () => {
    const { doc, heroId } = withHero();
    const r = run(doc, { type: 'UPDATE_STYLES', nodeId: heroId, patch: { paddingTop: '80px' } }, { type: 'UPDATE_RESPONSIVE', nodeId: heroId, device: 'mobile', patch: { paddingTop: '40px' } });
    const hero = r.doc.root.children[0];
    expect(hero.styles.paddingTop).toBe('80px');
    expect(hero.responsive.mobile).toEqual({ paddingTop: '40px' });
    expect(hero.responsive.desktop).toBeUndefined();
  });

  it('null in a patch removes the key', () => {
    const { doc, heroId } = withHero();
    const r = run(doc, { type: 'UPDATE_PROPS', nodeId: heroId, patch: { description: null } });
    expect(r.doc.root.children[0].props).not.toHaveProperty('description');
  });

  it('MOVE_NODE blocks cycles and forbidden parents', () => {
    const d0 = fresh();
    const a = run(d0, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'section' });
    const sectionId = a.doc.root.children[0].id;
    const b = run(a.doc, { type: 'ADD_NODE', parentId: sectionId, componentType: 'container' });
    const containerId = b.doc.root.children[0].children[0].id;
    expect(code(() => run(b.doc, { type: 'MOVE_NODE', nodeId: sectionId, newParentId: containerId }))).toBe('INVALID_TREE');
    expect(code(() => run(b.doc, { type: 'MOVE_NODE', nodeId: d0.root.id, newParentId: sectionId }))).toBe('INVALID_TREE');
    const ok = run(b.doc, { type: 'MOVE_NODE', nodeId: containerId, newParentId: d0.root.id, index: 0 });
    expect(ok.doc.root.children[0].id).toBe(containerId);
  });

  it('DUPLICATE_NODE clones the subtree with all-new ids', () => {
    const { doc, heroId } = withHero();
    const withChild = run(doc, { type: 'ADD_NODE', parentId: heroId, componentType: 'heading' }).doc;
    const r = run(withChild, { type: 'DUPLICATE_NODE', nodeId: heroId });
    expect(r.doc.root.children).toHaveLength(2);
    const ids = new Set<string>();
    const walk = (n: DocumentJson['root']) => (ids.add(n.id), n.children.forEach(walk));
    walk(r.doc.root);
    expect(ids.size).toBe(5); // page + 2 heroes + 2 headings - no id reused
    validateDocument(r.doc, limits, PAGE);
  });

  it('WRAP_NODE / UNWRAP_NODE round-trip, REORDER_CHILDREN validates permutations', () => {
    const d0 = fresh();
    const a = run(d0, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'heading' }, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'text' });
    const [h, t] = a.doc.root.children.map((c) => c.id);
    const wrapped = run(a.doc, { type: 'WRAP_NODE', nodeId: h, wrapperType: 'container' });
    const wrapperId = wrapped.results[0].createdNodeIds[0];
    expect(wrapped.doc.root.children[0].id).toBe(wrapperId);
    expect(wrapped.doc.root.children[0].children[0].id).toBe(h);
    const unwrapped = run(wrapped.doc, { type: 'UNWRAP_NODE', nodeId: wrapperId });
    expect(unwrapped.doc.root.children.map((c) => c.id)).toEqual([h, t]);
    const reordered = run(unwrapped.doc, { type: 'REORDER_CHILDREN', parentId: d0.root.id, childIds: [t, h] });
    expect(reordered.doc.root.children.map((c) => c.id)).toEqual([t, h]);
    expect(code(() => run(unwrapped.doc, { type: 'REORDER_CHILDREN', parentId: d0.root.id, childIds: [t] }))).toBe('ACTION_INVALID');
  });

  it('locked nodes (and their descendants) reject edits until unlocked', () => {
    const { doc, heroId } = withHero();
    const withChild = run(doc, { type: 'ADD_NODE', parentId: heroId, componentType: 'heading' }).doc;
    const childId = withChild.root.children[0].children[0].id;
    const locked = run(withChild, { type: 'LOCK_NODE', nodeId: heroId }).doc;
    expect(code(() => run(locked, { type: 'UPDATE_PROPS', nodeId: childId, patch: { text: 'x' } }))).toBe('ACTION_INVALID');
    expect(code(() => run(locked, { type: 'DELETE_NODE', nodeId: heroId }))).toBe('ACTION_INVALID');
    const unlocked = run(locked, { type: 'UNLOCK_NODE', nodeId: heroId }, { type: 'UPDATE_PROPS', nodeId: childId, patch: { text: 'x' } });
    expect(unlocked.doc.root.children[0].children[0].props.text).toBe('x');
  });

  it('UPDATE_VISIBILITY accepts a partial device patch but not an empty one', () => {
    const { doc, heroId } = withHero();
    const v = run(doc, { type: 'UPDATE_VISIBILITY', nodeId: heroId, patch: { tablet: false } }).doc.root.children[0].visibility;
    expect(v).toEqual({ desktop: true, tablet: false, mobile: true });
    expect(builderActionSchema.safeParse({ type: 'UPDATE_VISIBILITY', nodeId: heroId, patch: {} }).success).toBe(false);
  });

  it('HIDE_NODE / SHOW_NODE toggle device visibility', () => {
    const { doc, heroId } = withHero();
    const hidden = run(doc, { type: 'HIDE_NODE', nodeId: heroId, devices: ['mobile'] }).doc.root.children[0];
    expect(hidden.visibility).toEqual({ desktop: true, tablet: true, mobile: false });
    const shown = run(doc, { type: 'HIDE_NODE', nodeId: heroId }, { type: 'SHOW_NODE', nodeId: heroId }).doc.root.children[0];
    expect(Object.values(shown.visibility).every(Boolean)).toBe(true);
  });

  it('REPLACE_MEDIA sets the right prop and references are tracked', () => {
    const { doc, heroId } = withHero();
    const r = run(doc, { type: 'REPLACE_MEDIA', nodeId: heroId, assetId: '900010' }).doc;
    expect(r.root.children[0].props.mediaAssetId).toBe('900010');
    expect(collectReferences(r)).toEqual([{ refType: 'media', refKey: '900010', nodeId: heroId }]);
    expect(code(() => run(doc, { type: 'REPLACE_MEDIA', nodeId: doc.root.id, assetId: '900010' }))).toBe('CAPABILITY_NOT_SUPPORTED');
  });

  it('INSERT_BLOCK builds a validated subtree with fresh ids; APPLY_THEME sets root theme', () => {
    const d0 = fresh();
    const r = run(
      d0,
      { type: 'INSERT_BLOCK', parentId: d0.root.id, block: { type: 'hero', props: { title: 'T' }, children: [{ type: 'heading' }, { type: 'button', props: { label: 'Go' } }] } },
      { type: 'APPLY_THEME', tokens: { primary: '#111827' } },
    );
    expect(r.doc.root.children[0].children).toHaveLength(2);
    expect(r.doc.root.props.theme).toEqual({ primary: '#111827' });
    validateDocument(r.doc, limits, PAGE);
    expect(code(() => run(d0, { type: 'INSERT_BLOCK', parentId: d0.root.id, block: { type: 'hero', children: [{ type: 'hero' }] } }))).toBe('INVALID_TREE');
  });

  it('a failing action aborts the whole batch', () => {
    const d0 = fresh();
    expect(() =>
      run(d0, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'heading' }, { type: 'DELETE_NODE', nodeId: d0.root.id }),
    ).toThrow(AppError);
    expect(d0.root.children).toHaveLength(0);
  });

  it('rejects malformed actions at the schema level', () => {
    expect(builderActionSchema.safeParse({ type: 'UPDATE_PROPS', nodeId: 12345, patch: {} }).success).toBe(false); // number id
    expect(builderActionSchema.safeParse({ type: 'EXPLODE' }).success).toBe(false);
    expect(builderActionSchema.safeParse({ type: 'DELETE_NODE', nodeId: '1', extra: true }).success).toBe(false);
    // top-level __proto__ is dropped by the parser (never reaches the reducer); nested ones are rejected
    const top = builderActionSchema.safeParse(JSON.parse('{"type":"UPDATE_PROPS","nodeId":"1","patch":{"__proto__":{"x":1}}}'));
    expect(top.success && Object.hasOwn((top.data as { patch: object }).patch, '__proto__')).toBe(false);
    expect(builderActionSchema.safeParse(JSON.parse('{"type":"UPDATE_PROPS","nodeId":"1","patch":{"a":{"__proto__":{"x":1}}}}')).success).toBe(false);
  });
});

describe('security validation', () => {
  it('blocks unsafe URLs, script markup and event handlers', () => {
    const { doc, heroId } = withHero();
    expect(code(() => run(doc, { type: 'UPDATE_LINK', nodeId: heroId, link: { href: 'javascript:alert(1)' } }))).toBe('UNSAFE_CONTENT');
    expect(code(() => run(doc, { type: 'UPDATE_LINK', nodeId: heroId, link: { href: '  JaVaScRiPt:alert(1)' } }))).toBe('UNSAFE_CONTENT');
    expect(code(() => run(doc, { type: 'UPDATE_LINK', nodeId: heroId, link: { href: '//evil.example' } }))).toBe('UNSAFE_CONTENT');
    expect(code(() => run(doc, { type: 'UPDATE_PROPS', nodeId: heroId, patch: { description: '<script>alert(1)</script>' } }))).toBe('UNSAFE_CONTENT');
    expect(code(() => run(doc, { type: 'UPDATE_PROPS', nodeId: heroId, patch: { description: '<img src=x onerror=alert(1)>' } }))).toBe('UNSAFE_CONTENT');
    expect(code(() => run(doc, { type: 'UPDATE_STYLES', nodeId: heroId, patch: { backgroundColor: 'url(javascript:alert(1))' } }))).toBe('UNSAFE_CONTENT');
  });

  it('allows safe links and adds rel=noopener for _blank', () => {
    const { doc, heroId } = withHero();
    const r = run(doc, { type: 'UPDATE_LINK', nodeId: heroId, link: { href: 'https://example.com/x', target: '_blank' } }).doc;
    expect(r.root.children[0].props.link).toEqual({ href: 'https://example.com/x', target: '_blank', rel: 'noopener noreferrer' });
    for (const href of ['/pricing', '#contact', 'mailto:a@b.co', 'tel:+911234567890']) {
      expect(code(() => run(doc, { type: 'UPDATE_LINK', nodeId: heroId, link: { href } }))).toBe('NO_ERROR');
    }
  });

  it('rejects non-BIGINT asset ids in props', () => {
    const d0 = fresh();
    const a = run(d0, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'image' }).doc;
    expect(code(() => run(a, { type: 'UPDATE_PROPS', nodeId: a.root.children[0].id, patch: { assetId: '12abc' } }))).toBe('ACTION_INVALID');
  });
});

describe('validateDocument limits', () => {
  it('enforces node count, depth and byte limits', () => {
    const d0 = fresh();
    const many = run(d0, ...Array.from({ length: 10 }, () => ({ type: 'ADD_NODE', parentId: d0.root.id, componentType: 'text' }))).doc;
    expect(code(() => validateDocument(many, { ...limits, maxNodes: 5 }))).toBe('DOCUMENT_TOO_LARGE');
    expect(code(() => validateDocument(many, { ...limits, maxBytes: 100 }))).toBe('DOCUMENT_TOO_LARGE');
    let doc = d0;
    let parent = d0.root.id;
    for (let i = 0; i < 6; i++) {
      doc = run(doc, { type: 'ADD_NODE', parentId: parent, componentType: 'container' }).doc;
      let n = doc.root;
      while (n.children.length) n = n.children[0];
      parent = n.id;
    }
    expect(code(() => validateDocument(doc, { ...limits, maxDepth: 4 }))).toBe('DOCUMENT_TOO_LARGE');
  });

  it('rejects structurally invalid documents', () => {
    const d = fresh();
    expect(code(() => validateDocument({ ...d, schemaVersion: 9 }, limits))).toBe('DOCUMENT_SCHEMA_INVALID');
    expect(code(() => validateDocument({ ...d, pageId: 700001 }, limits))).toBe('DOCUMENT_SCHEMA_INVALID');
    const dup = structuredClone(d);
    dup.root.children.push({ ...structuredClone(d.root), type: 'section', id: d.root.id });
    expect(code(() => validateDocument(dup, limits))).toBe('DOCUMENT_SCHEMA_INVALID');
  });
});

describe('structural diff', () => {
  it('reports added, removed, moved and modified nodes', () => {
    const d0 = fresh();
    const a = run(d0, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'heading' }, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'text' });
    const [h, t] = a.doc.root.children.map((c) => c.id);
    const b = run(a.doc, { type: 'UPDATE_PROPS', nodeId: h, patch: { text: 'New' } }, { type: 'REORDER_CHILDREN', parentId: d0.root.id, childIds: [t, h] }, { type: 'ADD_NODE', parentId: d0.root.id, componentType: 'button' });
    const d = diffDocuments(a.doc, b.doc);
    expect(d.summary).toEqual({ added: 1, removed: 0, moved: 2, modified: 1 });
    expect(d.changes.find((c) => c.kind === 'modified')).toMatchObject({ nodeId: h, fields: ['props'] });
    expect(diffDocuments(b.doc, a.doc).summary.removed).toBe(1);
  });
});
