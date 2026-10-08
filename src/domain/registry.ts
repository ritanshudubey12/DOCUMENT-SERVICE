import { z } from 'zod';
import { AppError } from '../common/errors';
import { bigintId } from './types';
import { assertSafeContent } from './security';

export type Capability =
  | 'content'
  | 'media'
  | 'buttons'
  | 'typography'
  | 'background'
  | 'spacing'
  | 'layout'
  | 'radius'
  | 'responsive'
  | 'visibility'
  | 'animation'
  | 'link';

export interface ComponentDef {
  type: string;
  version: number;
  category: string;
  capabilities: Capability[];
  allowedChildren: string[];
  propsSchema: z.ZodType<Record<string, unknown>>;
  defaults: Record<string, unknown>;
  /** Prop that holds the media asset reference, for components with the `media` capability. */
  mediaProp?: string;
}

export const linkSchema = z
  .object({
    href: z.string().min(1).max(2048),
    target: z.enum(['_self', '_blank']).optional(),
    rel: z.string().max(100).optional(),
  })
  .strict();

const text = (max: number) => z.string().max(max);
const optBigint = bigintId.optional();

function def(
  type: string,
  category: string,
  capabilities: Capability[],
  allowedChildren: string[],
  shape: z.ZodRawShape,
  defaults: Record<string, unknown> = {},
  mediaProp?: string,
): ComponentDef {
  const full = capabilities.includes('link') ? { ...shape, link: linkSchema.optional() } : shape;
  return {
    type,
    version: 1,
    category,
    capabilities,
    allowedChildren,
    propsSchema: z.object(full).strict() as unknown as z.ZodType<Record<string, unknown>>,
    defaults,
    mediaProp,
  };
}

const LAYOUT_BLOCKS = ['section', 'container', 'hero', 'header', 'footer', 'form', 'product_grid', 'testimonial'];
const LEAVES = ['heading', 'text', 'image', 'button'];
const COMMON: Capability[] = ['responsive', 'visibility'];

const defs: ComponentDef[] = [
  def('page', 'structure', ['content', 'background', 'typography', ...COMMON], [...LAYOUT_BLOCKS, ...LEAVES], {
    title: text(200).optional(),
    theme: z.record(z.string(), z.string().max(100)).optional(),
    themeId: optBigint,
  }),
  def('section', 'structure', ['background', 'spacing', 'layout', 'animation', ...COMMON], ['container', 'hero', 'form', 'product_grid', 'testimonial', ...LEAVES], {
    anchorId: z.string().regex(/^[a-zA-Z][\w-]{0,63}$/).optional(),
  }),
  def('container', 'structure', ['background', 'spacing', 'layout', 'animation', ...COMMON], ['container', 'form', 'product_grid', 'testimonial', ...LEAVES], {
    anchorId: z.string().regex(/^[a-zA-Z][\w-]{0,63}$/).optional(),
  }),
  def(
    'hero',
    'marketing',
    ['content', 'media', 'buttons', 'typography', 'background', 'spacing', 'layout', 'animation', 'link', ...COMMON],
    ['heading', 'text', 'button', 'image'],
    { title: text(300).optional(), description: text(2000).optional(), mediaAssetId: optBigint },
    { title: 'Your headline', description: '' },
    'mediaAssetId',
  ),
  def('heading', 'content', ['content', 'typography', 'spacing', 'animation', ...COMMON], [], {
    text: text(500).optional(),
    level: z.number().int().min(1).max(6).optional(),
  }, { text: 'Heading', level: 2 }),
  def('text', 'content', ['content', 'typography', 'spacing', 'link', ...COMMON], [], {
    content: text(20000).optional(),
  }, { content: '' }),
  def('image', 'media', ['media', 'layout', 'radius', 'spacing', 'animation', 'link', ...COMMON], [], {
    assetId: optBigint,
    alt: text(300).optional(),
    fit: z.enum(['cover', 'contain', 'fill']).optional(),
  }, { fit: 'cover' }, 'assetId'),
  // Deliberately has no `animation` capability.
  def('button', 'content', ['content', 'buttons', 'typography', 'background', 'radius', 'spacing', 'link', ...COMMON], [], {
    label: text(120).optional(),
    variant: z.enum(['primary', 'secondary', 'outline', 'ghost']).optional(),
    icon: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  }, { label: 'Button', variant: 'primary' }),
  def('header', 'structure', ['content', 'media', 'buttons', 'typography', 'background', 'spacing', 'link', ...COMMON], ['image', 'text', 'button'], {
    sticky: z.boolean().optional(),
    logoAssetId: optBigint,
    navigation: z.array(z.object({ label: text(80), href: z.string().max(2048) }).strict()).max(20).optional(),
  }, { sticky: false, navigation: [] }, 'logoAssetId'),
  def('footer', 'structure', ['content', 'typography', 'background', 'spacing', 'link', ...COMMON], ['text', 'image', 'button'], {
    copyright: text(300).optional(),
  }),
  def('form', 'forms', ['content', 'background', 'spacing', 'layout', ...COMMON], ['heading', 'text', 'button'], {
    fields: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-zA-Z][\w-]{0,39}$/),
            label: text(120),
            type: z.enum(['text', 'email', 'tel', 'textarea', 'select', 'checkbox']),
            required: z.boolean().optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    submitLabel: text(80).optional(),
    consentText: text(500).optional(),
  }, { fields: [], submitLabel: 'Submit' }),
  def('product_grid', 'commerce', ['content', 'layout', 'spacing', ...COMMON], ['heading'], {
    dataSource: z
      .object({
        type: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
        limit: z.number().int().min(1).max(100).optional(),
        filters: z.record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
      })
      .strict()
      .optional(),
    columns: z.number().int().min(1).max(6).optional(),
  }),
  def('testimonial', 'marketing', ['content', 'media', 'typography', 'background', 'spacing', ...COMMON], ['heading', 'text', 'image'], {
    quote: text(2000).optional(),
    author: text(120).optional(),
    rating: z.number().int().min(1).max(5).optional(),
    avatarAssetId: optBigint,
  }, {}, 'avatarAssetId'),
];

const REGISTRY = new Map(defs.map((d) => [d.type, d]));

export function getComponent(type: string): ComponentDef {
  const d = REGISTRY.get(type);
  if (!d) throw new AppError('COMPONENT_NOT_FOUND', `Unknown component type "${type}"`, { type });
  return d;
}

export const listComponents = () => [...REGISTRY.values()];

// ---- style rules -----------------------------------------------------------------

const SPACING = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'gap'];
const TYPO = ['color', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'textAlign', 'letterSpacing'];
const LAYOUT = ['width', 'maxWidth', 'height', 'minHeight', 'justifyContent', 'alignItems'];

export const STYLE_CAPABILITY: Record<string, Capability> = {
  backgroundColor: 'background',
  borderRadius: 'radius',
  animation: 'animation',
  ...Object.fromEntries(SPACING.map((k) => [k, 'spacing' as Capability])),
  ...Object.fromEntries(TYPO.map((k) => [k, 'typography' as Capability])),
  ...Object.fromEntries(LAYOUT.map((k) => [k, 'layout' as Capability])),
};

const styleValue = z.string().min(1).max(100).regex(/^[#\w\s.,%()+\-/]+$/, 'contains unsupported characters');
const animationValue = z.enum(['none', 'fade-in', 'slide-up', 'zoom-in']);

/** Validates style keys against the component's capabilities and values against safe patterns. */
export function validateStyles(def: ComponentDef, styles: Record<string, unknown>, where: string): void {
  for (const [key, value] of Object.entries(styles)) {
    const cap = STYLE_CAPABILITY[key];
    if (!cap) throw new AppError('ACTION_INVALID', `Unknown style property "${key}" in ${where}`, { key });
    if (!def.capabilities.includes(cap)) {
      throw new AppError('CAPABILITY_NOT_SUPPORTED', `Component "${def.type}" does not support "${cap}" (style "${key}")`, {
        type: def.type,
        capability: cap,
        key,
      });
    }
    assertSafeContent(value, `${where}.${key}`);
    const r = (key === 'animation' ? animationValue : styleValue).safeParse(value);
    if (!r.success) throw new AppError('ACTION_INVALID', `Invalid value for style "${key}" in ${where}`, { key, issue: r.error.issues[0]?.message });
  }
}

export function requireCapability(def: ComponentDef, cap: Capability): void {
  if (!def.capabilities.includes(cap)) {
    throw new AppError('CAPABILITY_NOT_SUPPORTED', `Component "${def.type}" does not support "${cap}"`, { type: def.type, capability: cap });
  }
}
