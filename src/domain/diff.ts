import { stableStringify } from '../common/hash';
import type { DocNode, DocumentJson } from './types';

export interface NodeChange {
  kind: 'added' | 'removed' | 'moved' | 'modified';
  nodeId: string;
  type: string;
  parentId?: string | null;
  fromParentId?: string | null;
  fromIndex?: number;
  toIndex?: number;
  fields?: string[];
}

interface Flat {
  node: DocNode;
  parentId: string | null;
  index: number;
}

function flatten(doc: DocumentJson): Map<string, Flat> {
  const out = new Map<string, Flat>();
  const stack: Flat[] = [{ node: doc.root, parentId: null, index: 0 }];
  while (stack.length) {
    const f = stack.pop()!;
    out.set(f.node.id, f);
    f.node.children.forEach((c, index) => stack.push({ node: c, parentId: f.node.id, index }));
  }
  return out;
}

const FIELDS = ['type', 'version', 'props', 'styles', 'responsive', 'visibility', 'locked'] as const;

/** Structural, node-level comparison of two documents (not a text diff). */
export function diffDocuments(from: DocumentJson, to: DocumentJson) {
  const a = flatten(from);
  const b = flatten(to);
  const changes: NodeChange[] = [];

  for (const [id, f] of a) {
    if (!b.has(id)) changes.push({ kind: 'removed', nodeId: id, type: f.node.type, fromParentId: f.parentId });
  }
  for (const [id, t] of b) {
    const f = a.get(id);
    if (!f) {
      changes.push({ kind: 'added', nodeId: id, type: t.node.type, parentId: t.parentId, toIndex: t.index });
      continue;
    }
    if (f.parentId !== t.parentId || f.index !== t.index) {
      changes.push({ kind: 'moved', nodeId: id, type: t.node.type, fromParentId: f.parentId, parentId: t.parentId, fromIndex: f.index, toIndex: t.index });
    }
    const fields = FIELDS.filter((k) => stableStringify(f.node[k]) !== stableStringify(t.node[k]));
    if (fields.length) changes.push({ kind: 'modified', nodeId: id, type: t.node.type, fields: [...fields] });
  }

  const count = (k: NodeChange['kind']) => changes.filter((c) => c.kind === k).length;
  return {
    summary: { added: count('added'), removed: count('removed'), moved: count('moved'), modified: count('modified') },
    changes,
  };
}
