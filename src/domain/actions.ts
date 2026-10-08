import { z } from 'zod';
import { DEVICES, bigintId } from './types';
import { assertSafeKeys } from './security';
import { AppError } from '../common/errors';

const id = bigintId;
const index = z.number().int().min(0).optional();
const record = z
  .record(z.string().max(64), z.unknown())
  .superRefine((v, ctx) => {
    try {
      assertSafeKeys(v, 'patch');
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: (e as AppError).message });
    }
  });
const device = z.enum(DEVICES);

const linkInput = z
  .object({
    href: z.string().min(1).max(2048),
    target: z.enum(['_self', '_blank']).optional(),
    rel: z.string().max(100).optional(),
  })
  .strict();

export const builderActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ADD_NODE'), parentId: id, componentType: z.string().max(64), index, props: record.optional(), styles: record.optional() }).strict(),
  z.object({ type: z.literal('DELETE_NODE'), nodeId: id }).strict(),
  z.object({ type: z.literal('MOVE_NODE'), nodeId: id, newParentId: id, index }).strict(),
  z.object({ type: z.literal('DUPLICATE_NODE'), nodeId: id }).strict(),
  z.object({ type: z.literal('UPDATE_PROPS'), nodeId: id, patch: record }).strict(),
  z.object({ type: z.literal('UPDATE_STYLES'), nodeId: id, patch: record }).strict(),
  z.object({ type: z.literal('UPDATE_RESPONSIVE'), nodeId: id, device, patch: record }).strict(),
  z.object({ type: z.literal('UPDATE_VISIBILITY'), nodeId: id, patch: z.partialRecord(device, z.boolean()).refine((p) => Object.keys(p).length > 0, 'patch must not be empty') }).strict(),
  z.object({ type: z.literal('UPDATE_LINK'), nodeId: id, link: linkInput.nullable() }).strict(),
  z.object({ type: z.literal('REORDER_CHILDREN'), parentId: id, childIds: z.array(id).max(5000) }).strict(),
  z.object({ type: z.literal('WRAP_NODE'), nodeId: id, wrapperType: z.string().max(64) }).strict(),
  z.object({ type: z.literal('UNWRAP_NODE'), nodeId: id }).strict(),
  z.object({ type: z.literal('LOCK_NODE'), nodeId: id }).strict(),
  z.object({ type: z.literal('UNLOCK_NODE'), nodeId: id }).strict(),
  z.object({ type: z.literal('HIDE_NODE'), nodeId: id, devices: z.array(device).min(1).optional() }).strict(),
  z.object({ type: z.literal('SHOW_NODE'), nodeId: id, devices: z.array(device).min(1).optional() }).strict(),
  z.object({ type: z.literal('REPLACE_MEDIA'), nodeId: id, assetId: id }).strict(),
  // Reusable-block template: {type, props?, styles?, children?[]} validated by the reducer (depth-guarded).
  z.object({ type: z.literal('INSERT_BLOCK'), parentId: id, index, block: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ type: z.literal('APPLY_THEME'), tokens: z.record(z.string().regex(/^[a-zA-Z][\w-]{0,40}$/), z.string().max(100)), themeId: id.optional() }).strict()
    .refine((a) => Object.keys(a.tokens).length <= 50, 'at most 50 theme tokens'),
]);

export type BuilderAction = z.infer<typeof builderActionSchema>;
export type ActionType = BuilderAction['type'];
