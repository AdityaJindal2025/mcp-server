import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/server';

export const REAUTH_COMMAND = 'npx gmail-docs-mcp auth';

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_DOC_REF'
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'SCOPE_MISSING'
  | 'DOC_NO_ACCESS'
  | 'DOC_NOT_FOUND'
  | 'TAB_NOT_FOUND'
  | 'DOC_NOT_ALLOWED'
  | 'RECIPIENT_NOT_ALLOWED'
  | 'TOO_MANY_RECIPIENTS'
  | 'INVALID_ADDRESS'
  | 'INVALID_SUBJECT'
  | 'RATE_LIMITED_LOCAL'
  | 'TOO_LARGE'
  | 'CONCURRENT_EDITS'
  | 'GOOGLE_RATE_LIMITED'
  | 'GOOGLE_UNAVAILABLE'
  | 'GOOGLE_BAD_REQUEST'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PARTIAL_WRITE'
  | 'INTERNAL';

/** An error whose message is safe and useful to show to the model. */
export class ToolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface GoogleErrorInfo {
  status?: number;
  /** `errors[0].reason` from a Google API error body, e.g. `insufficientPermissions`. */
  reason?: string;
  /** `error.status` from a Google API error body, e.g. `PERMISSION_DENIED`. */
  apiStatus?: string;
  message?: string;
  /** OAuth error string from the token endpoint, e.g. `invalid_grant`. */
  oauthError?: string;
  /** Node/network error code, e.g. `ECONNRESET`. */
  netCode?: string;
  /** True for abort/timeout errors. */
  timeout?: boolean;
  /** `Retry-After` header in milliseconds, when present. */
  retryAfterMs?: number;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

/** Extracts the useful bits from a gaxios / google-auth-library / network error. */
export function googleErrorInfo(err: unknown): GoogleErrorInfo {
  const e = asRecord(err) ?? {};
  const info: GoogleErrorInfo = {};
  const response = asRecord(e['response']);
  const status = e['status'] ?? response?.['status'];
  if (typeof status === 'number') info.status = status;
  else if (typeof e['code'] === 'number') info.status = e['code'];

  const data = asRecord(response?.['data']);
  const apiErr = asRecord(data?.['error']);
  if (apiErr) {
    if (typeof apiErr['message'] === 'string') info.message = apiErr['message'];
    if (typeof apiErr['status'] === 'string') info.apiStatus = apiErr['status'];
    const errors = apiErr['errors'];
    if (Array.isArray(errors)) {
      const reason = asRecord(errors[0])?.['reason'];
      if (typeof reason === 'string') info.reason = reason;
    }
    const details = apiErr['details'];
    if (!info.reason && Array.isArray(details)) {
      for (const d of details) {
        const r = asRecord(d)?.['reason'];
        if (typeof r === 'string') {
          info.reason = r;
          break;
        }
      }
    }
  } else if (typeof data?.['error'] === 'string') {
    info.oauthError = data['error'];
    if (typeof data['error_description'] === 'string') info.message = data['error_description'];
  }

  const msg = typeof e['message'] === 'string' ? e['message'] : undefined;
  if (!info.message && msg) info.message = msg;
  if (!info.oauthError && msg && /\binvalid_grant\b/.test(msg)) info.oauthError = 'invalid_grant';

  if (typeof e['code'] === 'string') info.netCode = e['code'];
  const name = typeof e['name'] === 'string' ? e['name'] : '';
  if (name === 'AbortError' || name === 'TimeoutError' || info.netCode === 'ETIMEDOUT') {
    info.timeout = true;
  }

  const headers = response?.['headers'];
  let retryAfter: unknown;
  if (headers && typeof (headers as Headers).get === 'function') {
    retryAfter = (headers as Headers).get('retry-after');
  } else {
    retryAfter = asRecord(headers)?.['retry-after'];
  }
  if (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter)) {
    info.retryAfterMs = Number(retryAfter) * 1000;
  }
  return info;
}

export interface ErrorContext {
  api: 'Gmail' | 'Google Docs';
  docId?: string;
  accountEmail?: string;
  /** True for `messages.send`: an ambiguous failure means the email may have been sent. */
  sending?: boolean;
}

const account = (email?: string) => (email ? ` (${email})` : '');

/** Maps any error thrown while talking to Google into an actionable ToolError (§9). */
export function mapGoogleError(err: unknown, ctx: ErrorContext): ToolError {
  if (err instanceof ToolError) return err;
  const info = googleErrorInfo(err);

  if (info.oauthError === 'invalid_grant' || info.oauthError === 'unauthorized_client') {
    return new ToolError(
      'AUTH_EXPIRED',
      `The Google sign-in has expired or was revoked. Run \`${REAUTH_COMMAND}\` to sign in again. ` +
        `(If the OAuth consent screen is External and in Testing status, tokens expire after 7 days.)`,
    );
  }
  if (info.status === 401) {
    return new ToolError(
      'AUTH_EXPIRED',
      `Google rejected the stored credentials. Run \`${REAUTH_COMMAND}\` to sign in again.`,
    );
  }
  if (
    info.status === 403 &&
    (info.reason === 'insufficientPermissions' ||
      info.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ||
      /insufficient authentication scopes/i.test(info.message ?? ''))
  ) {
    return new ToolError(
      'SCOPE_MISSING',
      `The Google sign-in is missing a permission needed for ${ctx.api}. Run \`${REAUTH_COMMAND}\` again to grant it.`,
    );
  }
  if (
    info.status === 403 &&
    (info.reason === 'dailyLimitExceeded' ||
      info.reason === 'userRateLimitExceeded' ||
      info.reason === 'rateLimitExceeded')
  ) {
    return new ToolError(
      'GOOGLE_RATE_LIMITED',
      info.reason === 'dailyLimitExceeded'
        ? `The ${ctx.api} daily limit for this account has been reached. Try again tomorrow.`
        : `Google is rate-limiting ${ctx.api} requests. Wait a minute and retry.`,
    );
  }
  if (info.status === 403 && ctx.api === 'Google Docs') {
    return new ToolError(
      'DOC_NO_ACCESS',
      `The connected Google account${account(ctx.accountEmail)} does not have edit access to this document. ` +
        `Share it with ${ctx.accountEmail ?? 'that account'} as an Editor and retry.`,
    );
  }
  if (info.status === 403) {
    return new ToolError(
      'SCOPE_MISSING',
      `Google denied the ${ctx.api} request: ${info.message ?? 'permission denied'}. ` +
        `If permissions changed, run \`${REAUTH_COMMAND}\` again.`,
    );
  }
  if (info.status === 404 && ctx.api === 'Google Docs') {
    const which = ctx.docId ? `Document ${ctx.docId}` : 'The document';
    return new ToolError(
      'DOC_NOT_FOUND',
      `${which} was not found. Check the URL, and that it is shared with the connected Google account${account(ctx.accountEmail)}.`,
    );
  }
  if (info.status === 429) {
    return new ToolError(
      'GOOGLE_RATE_LIMITED',
      `Google is rate-limiting ${ctx.api} requests. Wait a minute and retry.`,
    );
  }
  if (info.status === 400) {
    return new ToolError(
      'GOOGLE_BAD_REQUEST',
      `${ctx.api} rejected the request: ${info.message ?? 'bad request'}.`,
    );
  }
  if ((info.status !== undefined && info.status >= 500) || info.timeout || info.netCode) {
    const maybe = ctx.sending
      ? ' The email may or may not have been sent; check the Sent folder before retrying.'
      : ' Retry in a moment.';
    return new ToolError('GOOGLE_UNAVAILABLE', `${ctx.api} did not respond successfully.${maybe}`);
  }
  return internalError(err);
}

export function internalError(err: unknown): ToolError {
  const ref = randomUUID();
  const e = new ToolError(
    'INTERNAL',
    `Unexpected server error (ref ${ref}). Check the server logs.`,
  );
  (e as ToolError & { ref: string; causeErr: unknown }).ref = ref;
  (e as ToolError & { ref: string; causeErr: unknown }).causeErr = err;
  return e;
}

export function toToolResult(err: ToolError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: err.message }] };
}
