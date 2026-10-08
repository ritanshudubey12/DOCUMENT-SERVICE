import { AppError, zodIssues } from '../common/errors';
import { isBigintId } from '../common/bigint';
import { DEVICES, SCHEMA_VERSION, type DocNode, type DocumentJson, type Limits } from './types';
import { getComponent, validateStyles } from './registry';
import { assertSafeContent, assertSafeKeys, assertSafeLink } from './security';

export interface DocStats {
  nodeCount: number;
  depth: number;
  bytes: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Full structural validation of a document: shape, component registry, tree rules,
 * props/styles/responsive/visibility, security and size limits.
 */
export function validateDocument(input: unknown, limits: Limits, expectedPageId?: string): DocStats {
  if (!isObj(input)) throw new AppError('DOCUMENT_SCHEMA_INVALID', 'Document must be an object');
  if (input.schemaVersion !== SCHEMA_VERSION) {
    throw new AppError('DOCUMENT_SCHEMA_INVALID', `Unsupported schemaVersion ${String(input.schemaVersion)}`);
  }
  if (!isBigintId(input.pageId)) throw new AppError('DOCUMENT_SCHEMA_INVALID', 'pageId must be a BIGINT string');
  if (expectedPageId && input.pageId !== expectedPageId) throw new AppError('DOCUMENT_SCHEMA_INVALID', 'pageId mismatch');

  const bytes = Buffer.byteLength(JSON.stringify(input));
  if (bytes > limits.maxBytes) throw new AppError('DOCUMENT_TOO_LARGE', `Document exceeds ${limits.maxBytes} bytes`, { bytes });

  const root = input.root as DocNode;
  if (!isObj(root) || root.type !== 'page') throw new AppError('DOCUMENT_SCHEMA_INVALID', 'Root node must be of type "page"');

  const seen = new Set<string>();
  let nodeCount = 0;
  let maxDepth = 0;
  // iterative walk: untrusted input must not be able to overflow the call stack
  const stack: Array<{ node: DocNode; depth: number; parent: DocNode | null }> = [{ node: root, depth: 1, parent: null }];

  while (stack.length) {
    const { node, depth, parent } = stack.pop()!;
    if (++nodeCount > limits.maxNodes) throw new AppError('DOCUMENT_TOO_LARGE', `Document exceeds ${limits.maxNodes} nodes`);
    if (depth > limits.maxDepth) throw new AppError('DOCUMENT_TOO_LARGE', `Document exceeds depth ${limits.maxDepth}`);
    maxDepth = Math.max(maxDepth, depth);
    validateNode(node, seen, parent);
    for (const child of node.children) stack.push({ node: child, depth: depth + 1, parent: node });
  }
  return { nodeCount, depth: maxDepth, bytes };
}

function validateNode(node: DocNode, seen: Set<string>, parent: DocNode | null): void {
  if (!isObj(node)) throw new AppError('DOCUMENT_SCHEMA_INVALID', 'Node must be an object');
  const where = `node ${String(node.id)}`;
  if (!isBigintId(node.id)) throw new AppError('DOCUMENT_SCHEMA_INVALID', `Invalid node id in ${where}`);
  if (seen.has(node.id)) throw new AppError('DOCUMENT_SCHEMA_INVALID', `Duplicate node id ${node.id}`);
  seen.add(node.id);

  if (typeof node.type !== 'string') throw new AppError('DOCUMENT_SCHEMA_INVALID', `Missing type in ${where}`);
  const def = getComponent(node.type);
  if (!Number.isInteger(node.version) || node.version < 1 || node.version > def.version) {
    throw new AppError('COMPONENT_NOT_FOUND', `Unsupported version ${String(node.version)} of "${node.type}"`);
  }
  for (const f of ['props', 'styles', 'responsive', 'visibility'] as const) {
    if (!isObj(node[f])) throw new AppError('DOCUMENT_SCHEMA_INVALID', `${f} must be an object in ${where}`);
    assertSafeKeys(node[f], `${where}.${f}`);
  }
  if (!Array.isArray(node.children)) throw new AppError('DOCUMENT_SCHEMA_INVALID', `children must be an array in ${where}`);
  if (node.locked !== undefined && typeof node.locked !== 'boolean') throw new AppError('DOCUMENT_SCHEMA_INVALID', `locked must be boolean in ${where}`);

  if (parent && !getComponent(parent.type).allowedChildren.includes(node.type)) {
    throw new AppError('INVALID_TREE', `"${node.type}" is not allowed inside "${parent.type}"`, { nodeId: node.id, parentId: parent.id });
  }

  assertSafeContent(node.props, `${where}.props`);
  const parsed = def.propsSchema.safeParse(node.props);
  if (!parsed.success) throw new AppError('DOCUMENT_SCHEMA_INVALID', `Invalid props in ${where}`, zodIssues(parsed.error));
  const link = node.props.link as { href?: string } | undefined;
  if (link?.href) assertSafeLink(link.href, `${where}.props.link`);
  const nav = node.props.navigation as Array<{ href: string }> | undefined;
  nav?.forEach((n) => assertSafeLink(n.href, `${where}.props.navigation`));

  validateStyles(def, node.styles, `${where}.styles`);

  for (const [device, styles] of Object.entries(node.responsive)) {
    if (!(DEVICES as readonly string[]).includes(device)) throw new AppError('DOCUMENT_SCHEMA_INVALID', `Unknown device "${device}" in ${where}.responsive`);
    if (!isObj(styles)) throw new AppError('DOCUMENT_SCHEMA_INVALID', `responsive.${device} must be an object in ${where}`);
    validateStyles(def, styles, `${where}.responsive.${device}`);
  }
  for (const [device, v] of Object.entries(node.visibility)) {
    if (!(DEVICES as readonly string[]).includes(device) || typeof v !== 'boolean') {
      throw new AppError('DOCUMENT_SCHEMA_INVALID', `Invalid visibility entry "${device}" in ${where}`);
    }
  }
}

export interface DocReference {
  refType: 'media' | 'data_source';
  refKey: string;
  nodeId: string;
}

/** Collects asset and data-source references so dependencies can be tracked. */
export function collectReferences(doc: DocumentJson): DocReference[] {
  const refs: DocReference[] = [];
  const stack: DocNode[] = [doc.root];
  while (stack.length) {
    const node = stack.pop()!;
    for (const [k, v] of Object.entries(node.props)) {
      if ((k === 'assetId' || k.endsWith('AssetId')) && typeof v === 'string') refs.push({ refType: 'media', refKey: v, nodeId: node.id });
      if (k === 'dataSource' && isObj(v) && typeof v.type === 'string') refs.push({ refType: 'data_source', refKey: v.type, nodeId: node.id });
    }
    stack.push(...node.children);
  }
  return refs;
}
