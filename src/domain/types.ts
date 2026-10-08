import { z } from 'zod';
import { isBigintId } from '../common/bigint';

export const DEVICES = ['desktop', 'tablet', 'mobile'] as const;
export type Device = (typeof DEVICES)[number];

export const SOURCES = ['EDITOR', 'AI', 'IMPORT', 'RESTORE', 'MIGRATION', 'SYSTEM'] as const;
export type RevisionSource = (typeof SOURCES)[number];

export const SCHEMA_VERSION = 1;

/** Node ids, asset ids etc. are BIGINT: canonical decimal strings on the wire, never Number. */
export const bigintId = z.string().refine(isBigintId, 'must be a positive 64-bit integer string');

export interface DocNode {
  id: string;
  type: string;
  version: number;
  props: Record<string, unknown>;
  styles: Record<string, unknown>;
  responsive: Record<string, Record<string, unknown>>;
  visibility: Record<string, boolean>;
  children: DocNode[];
  locked?: boolean;
}

export interface DocumentJson {
  schemaVersion: number;
  pageId: string;
  root: DocNode;
}

export interface Limits {
  maxNodes: number;
  maxDepth: number;
  maxBytes: number;
}
