export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'RESOURCE_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DOCUMENT_SCHEMA_INVALID'
  | 'ACTION_INVALID'
  | 'COMPONENT_NOT_FOUND'
  | 'CAPABILITY_NOT_SUPPORTED'
  | 'INVALID_TREE'
  | 'REFERENCE_INVALID'
  | 'DOCUMENT_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  // additions to the report's catalogue
  | 'BAD_REQUEST'
  | 'INVALID_IDENTIFIER'
  | 'UNSAFE_CONTENT'
  | 'DOCUMENT_LOCKED'
  | 'DOCUMENT_EXISTS';

const STATUS: Record<ErrorCode, number> = {
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  RESOURCE_NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  DOCUMENT_SCHEMA_INVALID: 422,
  ACTION_INVALID: 422,
  COMPONENT_NOT_FOUND: 422,
  CAPABILITY_NOT_SUPPORTED: 422,
  INVALID_TREE: 422,
  REFERENCE_INVALID: 422,
  DOCUMENT_TOO_LARGE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  BAD_REQUEST: 400,
  INVALID_IDENTIFIER: 400,
  UNSAFE_CONTENT: 422,
  DOCUMENT_LOCKED: 423,
  DOCUMENT_EXISTS: 409,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    status?: number,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status ?? STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('RESOURCE_NOT_FOUND', `${what} not found`);

export function zodIssues(err: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) {
  return err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}
