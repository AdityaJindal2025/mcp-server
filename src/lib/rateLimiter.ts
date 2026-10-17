import { ToolError } from './errors.js';

export interface Reservation {
  /** Records the send; it now counts against the window. */
  commit(): void;
  /** Gives the slot back (the send did not happen). */
  release(): void;
}

/**
 * In-memory sliding-window limiter for EMAIL_MAX_PER_HOUR (D6). Callers
 * reserve a slot before sending so concurrent calls can't overshoot, then
 * commit on success or release on failure. Only successful sends count.
 */
export class SlidingWindowLimiter {
  private sent: number[] = [];
  private pending = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  reserve(): Reservation {
    const t = this.now();
    this.sent = this.sent.filter((ts) => t - ts < this.windowMs);
    if (this.sent.length + this.pending >= this.limit) {
      const oldest = this.sent[0] ?? t;
      const minutes = Math.max(1, Math.ceil((oldest + this.windowMs - t) / 60_000));
      throw new ToolError(
        'RATE_LIMITED_LOCAL',
        `Hourly send limit (${this.limit}) reached. Next send allowed in ~${minutes} minute${minutes === 1 ? '' : 's'}. Nothing was sent.`,
      );
    }
    this.pending++;
    let done = false;
    return {
      commit: () => {
        if (done) return;
        done = true;
        this.pending--;
        this.sent.push(this.now());
      },
      release: () => {
        if (done) return;
        done = true;
        this.pending--;
      },
    };
  }
}
