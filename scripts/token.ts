/**
 * Dev helper: prints a signed access token for local testing / Postman.
 * Usage: npm run token -- [--tenant 1001] [--org 2001] [--workspace 3001] [--actor 4001] [--scopes document:*]
 * In production, tokens are issued by the platform identity service, never by this service.
 */
import jwt from 'jsonwebtoken';
import { config } from '../src/config';

const args = process.argv.slice(2);
const get = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const token = jwt.sign(
  {
    tenantId: get('tenant', '1001'),
    organizationId: get('org', '2001'),
    workspaceId: get('workspace', '3001'),
    scopes: get('scopes', 'document:*').split(','),
    roles: ['editor'],
  },
  config.JWT_SECRET,
  {
    algorithm: 'HS256',
    subject: get('actor', '4001'),
    expiresIn: '8h',
    // jsonwebtoken throws on keys explicitly set to undefined, so only include them when configured
    ...(config.JWT_ISSUER ? { issuer: config.JWT_ISSUER } : {}),
    ...(config.JWT_AUDIENCE ? { audience: config.JWT_AUDIENCE } : {}),
  },
);
console.log(token);
