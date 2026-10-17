import { describe, expect, it, vi } from 'vitest';
import { retryableRead, retryableSend, withRetry } from '../../src/lib/retry.js';

const http = (status: number, retryAfter?: string) => ({
  response: { status, headers: retryAfter ? { 'retry-after': retryAfter } : {}, data: {} },
});
const noSleep = { sleep: async () => undefined, random: () => 0.5 };

describe('predicates', () => {
  it('retryableRead retries 429/5xx/transient network errors only', () => {
    for (const s of [429, 500, 502, 503, 504]) expect(retryableRead(http(s))).toBe(true);
    for (const s of [400, 401, 403, 404]) expect(retryableRead(http(s))).toBe(false);
    expect(retryableRead({ code: 'ECONNRESET' })).toBe(true);
    expect(retryableRead({ name: 'AbortError' })).toBe(true);
    expect(retryableRead({ code: 'EWHATEVER' })).toBe(false);
    expect(retryableRead({ response: { data: { error: 'invalid_grant' } } })).toBe(false);
  });
  it('retryableSend never retries ambiguous failures (D3)', () => {
    expect(retryableSend(http(429))).toBe(true);
    expect(retryableSend({ code: 'ECONNREFUSED' })).toBe(true);
    expect(retryableSend(http(500))).toBe(false);
    expect(retryableSend(http(503))).toBe(false);
    expect(retryableSend({ code: 'ECONNRESET' })).toBe(false);
    expect(retryableSend({ name: 'TimeoutError' })).toBe(false);
  });
});

describe('withRetry', () => {
  it('succeeds after transient failures', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(http(503))
      .mockRejectedValueOnce(http(429))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();
    await expect(withRetry(fn, { retryOn: retryableRead, onRetry, ...noSleep })).resolves.toBe(
      'ok',
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
  it('gives up after 3 attempts', async () => {
    const fn = vi.fn().mockRejectedValue(http(503));
    await expect(withRetry(fn, { retryOn: retryableRead, ...noSleep })).rejects.toEqual(http(503));
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(http(404));
    await expect(withRetry(fn, { retryOn: retryableRead, ...noSleep })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('honours Retry-After and uses jittered backoff otherwise', async () => {
    const delays: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(http(429, '2'))
      .mockRejectedValueOnce(http(503))
      .mockResolvedValue(1);
    await withRetry(fn, {
      retryOn: retryableRead,
      sleep: async (ms) => void delays.push(ms),
      random: () => 0.5,
    });
    expect(delays).toEqual([2000, 250]);
  });
  it('uses real timers by default', async () => {
    const fn = vi.fn().mockRejectedValueOnce(http(503)).mockResolvedValue('ok');
    await expect(withRetry(fn, { retryOn: retryableRead, baseMs: 1 })).resolves.toBe('ok');
  });
});
