import { z } from 'zod';
import { AppError, zodIssues } from '../common/errors';
import { DEVICES, SCHEMA_VERSION, type DocNode, type DocumentJson } from './types';
import { getComponent, requireCapability, validateStyles, type ComponentDef } from './registry';
import { assertSafeContent, assertSafeLink, assertSafeKeys } from './security';
import type { BuilderAction } from './actions';

export interface ReduceDeps {
  newId: () => string;
  maxDepth: number;
}

export interface ActionResult {
  type: string;
  createdNodeIds: string[];
}

interface Entry {
  node: DocNode;
  parent: DocNode | null;
}

const templateShape = z
  .object({
    type: z.string().max(64),
    props: z.record(z.string(), z.unknown()).optional(),
    styles: z.record(z.string(), z.unknown()).optional(),
    children: z.array(z.unknown()).optional(),
  })
  .strict();

const allDevices = () => Object.fromEntries(DEVICES.map((d) => [d, true])) as Record<string, boolean>;

export function createRootNode(newId: () => string): DocNode {
  return makeNode(getComponent('page'), newId(), {}, {});
}

export function createEmptyDocument(pageId: string, newId: () => string): DocumentJson {
  return { schemaVersion: SCHEMA_VERSION, pageId, root: createRootNode(newId) };
}

function makeNode(def: ComponentDef, id: string, props: Record<string, unknown>, styles: Record<string, unknown>): DocNode {
  return {
    id,
    type: def.type,
    version: def.version,
    props: { ...def.defaults, ...props },
    styles: { ...styles },
    responsive: {},
    visibility: allDevices(),
    children: [],
  };
}

function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

function parseProps(def: ComponentDef, props: Record<string, unknown>, where: string): Record<string, unknown> {
  assertSafeContent(props, where);
  const r = def.propsSchema.safeParse(props);
  if (!r.success) throw new AppError('ACTION_INVALID', `Invalid props for "${def.type}"`, zodIssues(r.error));
  const nav = (r.data as { navigation?: Array<{ href: string }> }).navigation;
  nav?.forEach((n) => assertSafeLink(n.href, `${where}.navigation`));
  return r.data;
}

/** Deep-clones a subtree assigning fresh BIGINT ids to every node. */
export function cloneWithNewIds(node: DocNode, newId: () => string): DocNode {
  const copy = structuredClone(node);
  const stack = [copy];
  while (stack.length) {
    const n = stack.pop()!;
    n.id = newId();
    stack.push(...n.children);
  }
  return copy;
}

class Tree {
  private index = new Map<string, Entry>();
  constructor(public root: DocNode) {
    this.reindex();
  }

  reindex(): void {
    this.index.clear();
    const stack: Entry[] = [{ node: this.root, parent: null }];
    while (stack.length) {
      const e = stack.pop()!;
      this.index.set(e.node.id, e);
      for (const c of e.node.children) stack.push({ node: c, parent: e.node });
    }
  }

  entry(id: string): Entry {
    const e = this.index.get(id);
    if (!e) throw new AppError('ACTION_INVALID', `Node ${id} not found`, { nodeId: id });
    return e;
  }

  node(id: string): DocNode {
    return this.entry(id).node;
  }

  /** Rejects edits to a node that is locked itself or sits under a locked ancestor. */
  assertEditable(id: string): void {
    let cur: Entry | undefined = this.entry(id);
    while (cur) {
      if (cur.node.locked) throw new AppError('ACTION_INVALID', `Node ${cur.node.id} is locked`, { reason: 'NODE_LOCKED', nodeId: cur.node.id });
      cur = cur.parent ? this.index.get(cur.parent.id) : undefined;
    }
  }

  isInSubtree(candidateId: string, ancestorId: string): boolean {
    let cur: Entry | undefined = this.index.get(candidateId);
    while (cur) {
      if (cur.node.id === ancestorId) return true;
      cur = cur.parent ? this.index.get(cur.parent.id) : undefined;
    }
    return false;
  }
}

function assertChildAllowed(parent: DocNode, childType: string): void {
  if (!getComponent(parent.type).allowedChildren.includes(childType)) {
    throw new AppError('INVALID_TREE', `"${childType}" is not allowed inside "${parent.type}"`, { parentId: parent.id, childType });
  }
}

function insertAt(parent: DocNode, node: DocNode, index?: number): void {
  if (index === undefined) {
    parent.children.push(node);
  } else {
    if (index > parent.children.length) throw new AppError('ACTION_INVALID', `index ${index} is out of range`, { index, length: parent.children.length });
    parent.children.splice(index, 0, node);
  }
}

function removeFromParent(entry: Entry): number {
  const parent = entry.parent!;
  const i = parent.children.indexOf(entry.node);
  parent.children.splice(i, 1);
  return i;
}

function buildFromTemplate(raw: unknown, parent: DocNode, deps: ReduceDeps, depth: number, created: DocNode[]): DocNode {
  if (depth > deps.maxDepth) throw new AppError('DOCUMENT_TOO_LARGE', `Block exceeds depth ${deps.maxDepth}`);
  const t = templateShape.safeParse(raw);
  if (!t.success) throw new AppError('ACTION_INVALID', 'Invalid block template', zodIssues(t.error));
  assertSafeKeys(t.data.props, 'block.props');
  assertSafeKeys(t.data.styles, 'block.styles');
  const def = getComponent(t.data.type);
  assertChildAllowed(parent, def.type);
  const styles = t.data.styles ?? {};
  validateStyles(def, styles, `block.${def.type}.styles`);
  const props = parseProps(def, { ...def.defaults, ...(t.data.props ?? {}) }, `block.${def.type}.props`);
  const node = makeNode(def, deps.newId(), props, styles);
  node.props = props;
  created.push(node);
  for (const child of t.data.children ?? []) node.children.push(buildFromTemplate(child, node, deps, depth + 1, created));
  return node;
}

/**
 * Pure reducer: applies a batch of Builder Actions to a document and returns a new document.
 * The input is never mutated. Any failing action aborts the whole batch.
 */
export function applyActions(doc: DocumentJson, actions: BuilderAction[], deps: ReduceDeps): { doc: DocumentJson; results: ActionResult[] } {
  const next: DocumentJson = structuredClone(doc);
  const tree = new Tree(next.root);
  const results: ActionResult[] = [];

  actions.forEach((action, i) => {
    try {
      const createdNodeIds = apply(tree, action, deps);
      tree.reindex();
      results.push({ type: action.type, createdNodeIds });
    } catch (e) {
      if (e instanceof AppError) {
        throw new AppError(e.code, `Action #${i} (${action.type}): ${e.message}`, { actionIndex: i, actionType: action.type, ...(typeof e.details === 'object' && e.details && !Array.isArray(e.details) ? e.details : { issues: e.details }) });
      }
      throw e;
    }
  });
  return { doc: next, results };
}

function apply(tree: Tree, a: BuilderAction, deps: ReduceDeps): string[] {
  switch (a.type) {
    case 'ADD_NODE': {
      const parent = tree.node(a.parentId);
      tree.assertEditable(parent.id);
      const def = getComponent(a.componentType);
      if (def.type === 'page') throw new AppError('INVALID_TREE', 'A page node cannot be added');
      assertChildAllowed(parent, def.type);
      const styles = a.styles ?? {};
      validateStyles(def, styles, 'styles');
      if (a.props && 'link' in a.props) throw new AppError('ACTION_INVALID', 'Use UPDATE_LINK to set a link');
      const props = parseProps(def, { ...def.defaults, ...(a.props ?? {}) }, 'props');
      const node = makeNode(def, deps.newId(), props, styles);
      node.props = props;
      insertAt(parent, node, a.index);
      return [node.id];
    }

    case 'DELETE_NODE': {
      const e = tree.entry(a.nodeId);
      if (!e.parent) throw new AppError('INVALID_TREE', 'The root node cannot be deleted');
      tree.assertEditable(a.nodeId);
      removeFromParent(e);
      return [];
    }

    case 'MOVE_NODE': {
      const e = tree.entry(a.nodeId);
      if (!e.parent) throw new AppError('INVALID_TREE', 'The root node cannot be moved');
      const target = tree.node(a.newParentId);
      tree.assertEditable(a.nodeId);
      tree.assertEditable(target.id);
      if (tree.isInSubtree(target.id, e.node.id)) throw new AppError('INVALID_TREE', 'A node cannot be moved into its own subtree');
      assertChildAllowed(target, e.node.type);
      const oldIndex = removeFromParent(e);
      try {
        insertAt(target, e.node, a.index);
      } catch (err) {
        e.parent.children.splice(oldIndex, 0, e.node);
        throw err;
      }
      return [];
    }

    case 'DUPLICATE_NODE': {
      const e = tree.entry(a.nodeId);
      if (!e.parent) throw new AppError('INVALID_TREE', 'The root node cannot be duplicated');
      tree.assertEditable(e.parent.id);
      const clone = cloneWithNewIds(e.node, deps.newId);
      delete clone.locked;
      e.parent.children.splice(e.parent.children.indexOf(e.node) + 1, 0, clone);
      return [clone.id];
    }

    case 'UPDATE_PROPS': {
      const node = tree.node(a.nodeId);
      tree.assertEditable(node.id);
      if ('link' in a.patch) throw new AppError('ACTION_INVALID', 'Use UPDATE_LINK to change a link');
      const def = getComponent(node.type);
      node.props = parseProps(def, applyPatch(node.props, a.patch), 'props');
      return [];
    }

    case 'UPDATE_STYLES': {
      const node = tree.node(a.nodeId);
      tree.assertEditable(node.id);
      const def = getComponent(node.type);
      validateStyles(def, Object.fromEntries(Object.entries(a.patch).filter(([, v]) => v !== null)), 'styles');
      node.styles = applyPatch(node.styles, a.patch);
      return [];
    }

    case 'UPDATE_RESPONSIVE': {
      const node = tree.node(a.nodeId);
      tree.assertEditable(node.id);
      const def = getComponent(node.type);
      requireCapability(def, 'responsive');
      validateStyles(def, Object.fromEntries(Object.entries(a.patch).filter(([, v]) => v !== null)), `responsive.${a.device}`);
      const merged = applyPatch(node.responsive[a.device] ?? {}, a.patch);
      node.responsive = { ...node.responsive, [a.device]: merged };
      return [];
    }

    case 'UPDATE_VISIBILITY': {
      const node = tree.node(a.nodeId);
      tree.assertEditable(node.id);
      requireCapability(getComponent(node.type), 'visibility');
      node.visibility = { ...node.visibility, ...a.patch };
      return [];
    }

    case 'UPDATE_LINK': {
      const node = tree.node(a.nodeId);
      tree.assertEditable(node.id);
      requireCapability(getComponent(node.type), 'link');
      if (a.link === null) {
        delete node.props.link;
      } else {
        assertSafeLink(a.link.href, 'link.href');
        assertSafeContent(a.link.rel, 'link.rel');
        const link = { ...a.link };
        if (link.target === '_blank' && !link.rel) link.rel = 'noopener noreferrer';
        node.props.link = link;
      }
      return [];
    }

    case 'REORDER_CHILDREN': {
      const parent = tree.node(a.parentId);
      tree.assertEditable(parent.id);
      const current = parent.children.map((c) => c.id);
      if (a.childIds.length !== current.length || new Set(a.childIds).size !== current.length || !a.childIds.every((c) => current.includes(c))) {
        throw new AppError('ACTION_INVALID', 'childIds must be a permutation of the current children', { current });
      }
      const byId = new Map(parent.children.map((c) => [c.id, c]));
      parent.children = a.childIds.map((c) => byId.get(c)!);
      return [];
    }

    case 'WRAP_NODE': {
      const e = tree.entry(a.nodeId);
      if (!e.parent) throw new AppError('INVALID_TREE', 'The root node cannot be wrapped');
      tree.assertEditable(a.nodeId);
      const wrapperDef = getComponent(a.wrapperType);
      if (wrapperDef.type === 'page') throw new AppError('INVALID_TREE', 'A page node cannot be used as a wrapper');
      assertChildAllowed(e.parent, wrapperDef.type);
      assertChildAllowed({ ...e.node, type: wrapperDef.type } as DocNode, e.node.type);
      const wrapper = makeNode(wrapperDef, deps.newId(), {}, {});
      const idx = removeFromParent(e);
      wrapper.children.push(e.node);
      e.parent.children.splice(idx, 0, wrapper);
      return [wrapper.id];
    }

    case 'UNWRAP_NODE': {
      const e = tree.entry(a.nodeId);
      if (!e.parent) throw new AppError('INVALID_TREE', 'The root node cannot be unwrapped');
      tree.assertEditable(a.nodeId);
      for (const c of e.node.children) assertChildAllowed(e.parent, c.type);
      const idx = removeFromParent(e);
      e.parent.children.splice(idx, 0, ...e.node.children);
      return [];
    }

    case 'LOCK_NODE': {
      tree.node(a.nodeId).locked = true;
      return [];
    }
    case 'UNLOCK_NODE': {
      delete tree.node(a.nodeId).locked;
      return [];
    }

    case 'HIDE_NODE':
    case 'SHOW_NODE': {
      const node = tree.node(a.nodeId);
      tree.assertEditable(node.id);
      requireCapability(getComponent(node.type), 'visibility');
      const value = a.type === 'SHOW_NODE';
      for (const d of a.devices ?? DEVICES) node.visibility = { ...node.visibility, [d]: value };
      return [];
    }

    case 'REPLACE_MEDIA': {
      const node = tree.node(a.nodeId);
      tree.assertEditable(node.id);
      const def = getComponent(node.type);
      requireCapability(def, 'media');
      if (!def.mediaProp) throw new AppError('CAPABILITY_NOT_SUPPORTED', `Component "${def.type}" has no replaceable media`);
      node.props = parseProps(def, { ...node.props, [def.mediaProp]: a.assetId }, 'props');
      return [];
    }

    case 'INSERT_BLOCK': {
      const parent = tree.node(a.parentId);
      tree.assertEditable(parent.id);
      const created: DocNode[] = [];
      const node = buildFromTemplate(a.block, parent, deps, 1, created);
      insertAt(parent, node, a.index);
      return [node.id];
    }

    case 'APPLY_THEME': {
      const root = tree.root;
      assertSafeContent(a.tokens, 'theme');
      root.props = { ...root.props, theme: a.tokens, ...(a.themeId ? { themeId: a.themeId } : {}) };
      return [];
    }
  }
}

