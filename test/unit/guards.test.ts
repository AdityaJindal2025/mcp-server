import { describe, expect, it } from 'vitest';
import {
  checkAllowedDomains,
  checkAppendSize,
  checkBody,
  checkDocAllowed,
  checkRecipientCount,
  checkSubject,
  isDomainAllowed,
  MAX_BODY_CHARS,
  normalizeAddress,
  normalizeRecipients,
} from '../../src/lib/guards.js';

describe('normalizeAddress', () => {
  it('trims and lowercases only the domain', () => {
    expect(normalizeAddress('  Alex.Smith@Example.COM ')).toBe('Alex.Smith@example.com');
  });
  it.each([
    ['a@b.com\r\nBcc: x@y.com', /line breaks/],
    ['a@b.com\n', /line breaks/],
    ['"Alex" <alex@example.com>', /bare email address/],
    ['alex @example.com', /bare email address/],
    ['a@example.com,b@example.com', /more than one address/],
    ['a@example.com;b@example.com', /more than one address/],
    ['not-an-email', /not a valid email/],
    ['a@localhost', /not a valid email/],
    ['a@-bad.com', /not a valid email/],
    [`${'x'.repeat(250)}@example.com`, /not a valid email/],
  ])('rejects %j', (input, msg) => {
    expect(() => normalizeAddress(input)).toThrow(msg);
  });
  it('accepts plus addressing and subdomains', () => {
    expect(normalizeAddress('a+tag@mail.example.co.uk')).toBe('a+tag@mail.example.co.uk');
  });
});

describe('normalizeRecipients', () => {
  it('dedupes case-insensitively with precedence to > cc > bcc', () => {
    const r = normalizeRecipients(
      ['A@x.com', 'a@X.com', 'b@x.com'],
      ['B@x.com', 'c@x.com'],
      ['c@x.com', 'd@x.com'],
    );
    expect(r).toEqual({ to: ['A@x.com', 'b@x.com'], cc: ['c@x.com'], bcc: ['d@x.com'] });
  });
  it('requires a to recipient', () => {
    expect(() => normalizeRecipients([])).toThrow(/At least one/);
  });
});

describe('limits and allowlists', () => {
  const r = normalizeRecipients(['a@example.com'], ['b@partner.com'], ['c@sub.example.com']);
  it('counts all recipients', () => {
    expect(() => checkRecipientCount(r, 3)).not.toThrow();
    expect(() => checkRecipientCount(r, 2)).toThrow(
      'Too many recipients (3). The limit is 2. Nothing was sent.',
    );
  });
  it('allows everything with an empty allowlist', () => {
    expect(() => checkAllowedDomains(r, [])).not.toThrow();
  });
  it('names every blocked address', () => {
    expect(() => checkAllowedDomains(r, ['example.com'])).toThrow(
      'Blocked recipient(s): b@partner.com, c@sub.example.com. This server only sends to: example.com. Nothing was sent.',
    );
  });
  it('supports subdomain entries with a leading dot', () => {
    expect(isDomainAllowed('c@sub.example.com', ['.example.com'])).toBe(true);
    expect(isDomainAllowed('c@example.com', ['.example.com'])).toBe(false);
    expect(isDomainAllowed('c@badexample.com', ['.example.com'])).toBe(false);
  });
  it('checks subject line breaks and length', () => {
    expect(checkSubject('Fine 🎉')).toBe('Fine 🎉');
    expect(() => checkSubject('a\r\nb')).toThrow(/single line/);
    expect(() => checkSubject('a\nb')).toThrow(/single line/);
    expect(() => checkSubject('🎉'.repeat(250))).not.toThrow();
    expect(() => checkSubject('x'.repeat(251))).toThrow(/longer than 250/);
  });
  it('checks body and append sizes', () => {
    expect(() => checkBody('x'.repeat(MAX_BODY_CHARS + 1))).toThrow(/limit is 1,000,000/);
    expect(() => checkAppendSize(61_200, 50_000)).toThrow(
      'Text is 61,200 characters; the limit is 50,000. Split it into smaller appends.',
    );
    expect(() => checkAppendSize(10, 50_000)).not.toThrow();
  });
  it('checks the doc allowlist', () => {
    expect(() => checkDocAllowed('abc', [])).not.toThrow();
    expect(() => checkDocAllowed('abc', ['abc'])).not.toThrow();
    expect(() => checkDocAllowed('abc', ['def'])).toThrow(
      'This server is not allowed to access document abc.',
    );
  });
});
