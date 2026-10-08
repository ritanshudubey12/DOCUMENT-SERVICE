import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config';
import { AppError } from '../common/errors';
import { bigintId } from '../domain/types';

/**
 * Verified identity. IDs are validated 64-bit decimal strings (never Number).
 * Built only from a verified token: client-supplied tenant/org/workspace/actor values are ignored.
 */
export interface RequestContext {
  actorId: string;
  tenantId: string;
  organizationId: string;
  workspaceId: string;
  softwareId?: string;
  scopes: string[];
  roles: string[];
  requestId: string;
  traceId?: string;
}

const claimsSchema = z.object({
  sub: bigintId,
  tenantId: bigintId,
  organizationId: bigintId,
  workspaceId: bigintId,
  softwareId: bigintId.optional(),
  scopes: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      ctx: RequestContext;
    }
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  const m = header && /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw new AppError('AUTH_REQUIRED', 'Missing bearer token');

  let payload: unknown;
  try {
    payload = jwt.verify(m[1], config.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });
  } catch {
    throw new AppError('AUTH_REQUIRED', 'Invalid or expired token');
  }
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) throw new AppError('AUTH_REQUIRED', 'Token is missing required identity claims');

  const c = claims.data;
  req.ctx = {
    actorId: c.sub,
    tenantId: c.tenantId,
    organizationId: c.organizationId,
    workspaceId: c.workspaceId,
    softwareId: c.softwareId,
    scopes: c.scopes,
    roles: c.roles,
    requestId: req.requestId,
    traceId: req.header('x-trace-id')?.slice(0, 64) || req.requestId,
  };
  next();
}

export const SCOPES = {
  read: 'document:read',
  write: 'document:write',
  restore: 'document:restore',
  publish: 'document:publish',
  ai: 'document:ai',
  import: 'document:import',
} as const;

export const hasScope = (ctx: RequestContext, scope: string) => ctx.scopes.includes(scope) || ctx.scopes.includes('document:*');

export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!hasScope(req.ctx, scope)) throw new AppError('FORBIDDEN', `Missing required permission: ${scope}`);
    next();
  };
}
