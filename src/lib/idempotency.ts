import { sha256 } from './audit.js';
import { ToolError } from './errors.js';

interface Entry<T> {
  argsHash: string;
  expiresAt: number;
  value?: T;
  inflight?: Promise<T>;
}

/** JSON with sorted keys, so argument order doesn't change the hash. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashArgs(args: Record<string, unknown>): string {
  const rest = { ...args };
  delete rest['client_request_id'];
  return sha256(stableStringify(rest));
}

/**
 * Duplicate-send protection for `client_request_id` (PS §9, P1). Successful
 * results are cached for 24 h; failures are not cached so a retry re-attempts.
 * In-memory per process (D6).
 */
export class IdempotencyCache<T> {
  private entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  async run(
    key: string,
    argsHash: string,
    fn: () => Promise<T>,
  ): Promise<{ value: T; cached: boolean }> {
    this.evictExpired();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.argsHash !== argsHash) {
        throw new ToolError(
          'IDEMPOTENCY_CONFLICT',
          `client_request_id "${key.split(':').slice(1).join(':')}" was already used with different arguments. Use a new client_request_id for a different request.`,
        );
      }
      if (existing.value !== undefined) return { value: existing.value, cached: true };
      if (existing.inflight) return { value: await existing.inflight, cached: true };
    }

    const entry: Entry<T> = { argsHash, expiresAt: this.now() + this.ttlMs };
    const inflight = fn();
    entry.inflight = inflight;
    this.entries.set(key, entry);
    try {
      const value = await inflight;
      entry.value = value;
      delete entry.inflight;
      this.trim();
      return { value, cached: false };
    } catch (err) {
      this.entries.delete(key);
      throw err;
    }
  }

  private evictExpired(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= t && !e.inflight) this.entries.delete(k);
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
