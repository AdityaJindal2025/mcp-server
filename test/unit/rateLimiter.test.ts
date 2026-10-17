import { expect, it } from 'vitest';
import { SlidingWindowLimiter } from '../../src/lib/rateLimiter.js';

it('counts committed sends within the window and frees slots as they expire', () => {
  let now = 0;
  const l = new SlidingWindowLimiter(2, 60 * 60 * 1000, () => now);
  l.reserve().commit();
  now = 10 * 60 * 1000;
  l.reserve().commit();
  expect(() => l.reserve()).toThrow(
    'Hourly send limit (2) reached. Next send allowed in ~50 minutes. Nothing was sent.',
  );
  now = 60 * 60 * 1000 + 1;
  expect(() => l.reserve().commit()).not.toThrow();
});

it('releases slots for failed sends and blocks concurrent overshoot', () => {
  const l = new SlidingWindowLimiter(1, 1000, () => 0);
  const r = l.reserve();
  expect(() => l.reserve()).toThrow(/limit/);
  r.release();
  r.commit(); // no-op after release
  const r2 = l.reserve();
  r2.commit();
  expect(() => l.reserve()).toThrow(/~1 minute\./);
});
