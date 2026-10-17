import { describe, expect, it } from 'vitest';
import {
  googleErrorInfo,
  internalError,
  mapGoogleError,
  toToolResult,
  ToolError,
} from '../../src/lib/errors.js';

const apiErr = (
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => ({
  status,
  message,
  response: { status, headers, data: { error: { code: status, message, ...extra } } },
});

const docsCtx = { api: 'Google Docs' as const, docId: 'DOC1', accountEmail: 'me@example.com' };
const gmailCtx = { api: 'Gmail' as const, sending: true };

describe('googleErrorInfo', () => {
  it('extracts status, reason, apiStatus and retry-after', () => {
    const info = googleErrorInfo(
      apiErr(
        429,
        'slow down',
        { status: 'RESOURCE_EXHAUSTED', errors: [{ reason: 'rateLimitExceeded' }] },
        { 'retry-after': '3' },
      ),
    );
    expect(info).toMatchObject({
      status: 429,
      reason: 'rateLimitExceeded',
      apiStatus: 'RESOURCE_EXHAUSTED',
      message: 'slow down',
      retryAfterMs: 3000,
    });
  });
  it('reads Headers objects and details reasons', () => {
    const e = {
      response: {
        status: 403,
        headers: new Headers({ 'retry-after': '2' }),
        data: { error: { message: 'x', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
      },
    };
    expect(googleErrorInfo(e)).toMatchObject({
      status: 403,
      reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
      retryAfterMs: 2000,
    });
  });
  it('extracts OAuth errors', () => {
    expect(
      googleErrorInfo({
        response: {
          status: 400,
          data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        },
      }),
    ).toMatchObject({ oauthError: 'invalid_grant', status: 400 });
    expect(googleErrorInfo(new Error('invalid_grant'))).toMatchObject({
      oauthError: 'invalid_grant',
    });
  });
  it('flags timeouts and network codes', () => {
    expect(googleErrorInfo(Object.assign(new Error('t'), { name: 'AbortError' })).timeout).toBe(
      true,
    );
    expect(googleErrorInfo({ code: 'ECONNRESET', message: 'reset' }).netCode).toBe('ECONNRESET');
    expect(googleErrorInfo({ code: 503 }).status).toBe(503);
    expect(googleErrorInfo(null)).toEqual({});
  });
});

describe('mapGoogleError', () => {
  it.each([
    [
      { response: { status: 400, data: { error: 'invalid_grant' } } },
      docsCtx,
      'AUTH_EXPIRED',
      /npx gmail-docs-mcp auth.*7 days/,
    ],
    [apiErr(401, 'unauth'), gmailCtx, 'AUTH_EXPIRED', /sign in again/],
    [
      apiErr(403, 'Request had insufficient authentication scopes.'),
      gmailCtx,
      'SCOPE_MISSING',
      /missing a permission needed for Gmail/,
    ],
    [
      apiErr(403, 'x', { errors: [{ reason: 'insufficientPermissions' }] }),
      docsCtx,
      'SCOPE_MISSING',
      /Google Docs/,
    ],
    [
      apiErr(403, 'x', { errors: [{ reason: 'dailyLimitExceeded' }] }),
      gmailCtx,
      'GOOGLE_RATE_LIMITED',
      /daily limit/,
    ],
    [
      apiErr(403, 'x', { errors: [{ reason: 'userRateLimitExceeded' }] }),
      gmailCtx,
      'GOOGLE_RATE_LIMITED',
      /rate-limiting/,
    ],
    [
      apiErr(403, 'The caller does not have permission', { status: 'PERMISSION_DENIED' }),
      docsCtx,
      'DOC_NO_ACCESS',
      /The connected Google account \(me@example.com\) does not have edit access to this document\./,
    ],
    [apiErr(403, 'Delegation denied'), gmailCtx, 'SCOPE_MISSING', /Delegation denied/],
    [apiErr(404, 'not found'), docsCtx, 'DOC_NOT_FOUND', /Document DOC1 was not found/],
    [apiErr(429, 'slow'), gmailCtx, 'GOOGLE_RATE_LIMITED', /Wait a minute/],
    [apiErr(400, 'Invalid requests[0]'), docsCtx, 'GOOGLE_BAD_REQUEST', /Invalid requests\[0\]/],
    [apiErr(503, 'down'), gmailCtx, 'GOOGLE_UNAVAILABLE', /may or may not have been sent/],
    [apiErr(500, 'down'), docsCtx, 'GOOGLE_UNAVAILABLE', /Retry in a moment/],
    [{ code: 'ETIMEDOUT', message: 'timeout' }, docsCtx, 'GOOGLE_UNAVAILABLE', /did not respond/],
  ])('maps case %#', (err, ctx, code, msg) => {
    const mapped = mapGoogleError(err, ctx);
    expect(mapped.code).toBe(code);
    expect(mapped.message).toMatch(msg);
  });

  it('handles missing doc id and account', () => {
    expect(mapGoogleError(apiErr(404, 'x'), { api: 'Google Docs' }).message).toMatch(
      /^The document was not found/,
    );
    expect(mapGoogleError(apiErr(403, 'x'), { api: 'Google Docs' }).message).toMatch(
      /Share it with that account/,
    );
  });

  it('passes ToolErrors through and wraps unknown errors', () => {
    const t = new ToolError('TOO_LARGE', 'x');
    expect(mapGoogleError(t, docsCtx)).toBe(t);
    const unknown = mapGoogleError(new TypeError('boom'), docsCtx);
    expect(unknown.code).toBe('INTERNAL');
    expect(unknown.message).toMatch(/Unexpected server error \(ref [0-9a-f-]{36}\)/);
  });
});

it('toToolResult builds an isError result', () => {
  expect(toToolResult(internalError('x'))).toMatchObject({
    isError: true,
    content: [{ type: 'text' }],
  });
});
