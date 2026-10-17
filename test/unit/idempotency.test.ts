import { describe, expect, it, vi } from 'vitest';
import { hashArgs, IdempotencyCache, stableStringify } from '../../src/lib/idempotency.js';

describe('stableStringify / hashArgs', () => {
  it('ignores key order, undefined values and client_request_id', () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe(
      '{"a":[1,{"d":2}],"b":1}',
    );
    expect(hashArgs({ a: 1, client_request_id: 'x' })).toBe(
      hashArgs({ a: 1, client_request_id: 'y' }),
    );
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
  });
});

describe('IdempotencyCache', () => {
  it('returns the cached value for the same key and args', async () => {
    const cache = new IdempotencyCache<string>();
    const fn = vi.fn().mockResolvedValue('result');
    expect(await cache.run('t:1', 'h', fn)).toEqual({ value: 'result', cached: false });
    expect(await cache.run('t:1', 'h', fn)).toEqual({ value: 'result', cached: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse with different args', async () => {
    const cache = new IdempotencyCache<string>();
    await cache.run('tool:abc', 'h1', async () => 'x');
    await expect(cache.run('tool:abc', 'h2', async () => 'y')).rejects.toThrow(
      /client_request_id "abc" was already used with different arguments/,
    );
  });

  it('does not cache failures', async () => {
    const cache = new IdempotencyCache<string>();
    await expect(
      cache.run('k', 'h', async () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(await cache.run('k', 'h', async () => 'ok')).toEqual({ value: 'ok', cached: false });
  });

  it('dedupes concurrent calls', async () => {
    const cache = new IdempotencyCache<string>();
    let resolve!: (v: string) => void;
    const fn = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const a = cache.run('k', 'h', fn);
    const b = cache.run('k', 'h', fn);
    resolve('v');
    expect(await a).toEqual({ value: 'v', cached: false });
    expect(await b).toEqual({ value: 'v', cached: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('expires entries after the TTL and trims to max size', async () => {
    let now = 0;
    const cache = new IdempotencyCache<number>(1000, 2, () => now);
    await cache.run('a', 'h', async () => 1);
    now = 1001;
    expect((await cache.run('a', 'h', async () => 2)).cached).toBe(false);
    await cache.run('b', 'h', async () => 3);
    await cache.run('c', 'h', async () => 4);
    // 'a' was evicted by the size cap.
    expect((await cache.run('a', 'h', async () => 5)).value).toBe(5);
  });
});
