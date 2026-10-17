import { googleErrorInfo } from './errors.js';

export interface RetryOptions {
  /** Total attempts including the first one. */
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  retryOn: (err: unknown) => boolean;
  /** Called before each retry; useful for logging. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const RETRYABLE_NET = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE']);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Reads and other idempotent calls: retry 429, 5xx and transient network errors (PS §10). */
export function retryableRead(err: unknown): boolean {
  const info = googleErrorInfo(err);
  if (info.status !== undefined) return RETRYABLE_STATUS.has(info.status);
  if (info.oauthError) return false;
  return info.timeout === true || (info.netCode !== undefined && RETRYABLE_NET.has(info.netCode));
}

/**
 * Non-idempotent sends (D3): retry only when Google definitely did not accept
 * the message, i.e. 429 or a connection that was refused before any request
 * was sent. 5xx and timeouts are ambiguous and are never retried.
 */
export function retryableSend(err: unknown): boolean {
  const info = googleErrorInfo(err);
  if (info.status === 429) return true;
  return info.status === undefined && info.netCode === 'ECONNREFUSED';
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter, honouring Retry-After (max 3 attempts by default). */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 250;
  const maxMs = opts.maxMs ?? 4000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !opts.retryOn(err)) throw err;
      const retryAfter = googleErrorInfo(err).retryAfterMs;
      const backoff = Math.floor(random() * Math.min(maxMs, baseMs * 2 ** (attempt - 1)));
      const delay = retryAfter !== undefined ? Math.min(retryAfter, 30_000) : backoff;
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}
