import { describe, expect, it } from 'vitest';
import { buildMime, encodeHeaderValue, foldAscii, toBase64Url } from '../../src/lib/mime.js';

/** Minimal RFC 2047 decoder for assertions. */
function decodeWords(value: string): string {
  const unfolded = value.replace(/\r\n /g, ' ');
  const words = [...unfolded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) =>
    Buffer.from(m[1]!, 'base64'),
  );
  return words.length ? Buffer.concat(words).toString('utf8') : unfolded;
}

function headers(mime: string): Record<string, string> {
  const head = mime.split('\r\n\r\n')[0]!.replace(/\r\n /g, '\r\n\t');
  const out: Record<string, string> = {};
  let last = '';
  for (const line of head.split('\r\n')) {
    if (line.startsWith('\t')) out[last] += `\r\n ${line.slice(1)}`;
    else {
      const i = line.indexOf(':');
      last = line.slice(0, i);
      out[last] = line.slice(i + 2);
    }
  }
  return out;
}

const base = {
  to: ['alex@example.com'],
  cc: [],
  bcc: [],
  body: 'Hello',
  format: 'text' as const,
  date: new Date('2026-10-17T10:00:00Z'),
};

describe('encodeHeaderValue', () => {
  it('leaves printable ASCII alone', () => {
    expect(encodeHeaderValue('Weekly update')).toBe('Weekly update');
  });

  it('round-trips emoji and CJK without splitting characters', () => {
    const subject = '週報 🚀🔥 Weekly update — résumé ' + '👨‍👩‍👧‍👦'.repeat(5);
    const encoded = encodeHeaderValue(subject);
    for (const word of encoded.split('\r\n ')) {
      expect(word.length).toBeLessThanOrEqual(75);
      const inner = /=\?UTF-8\?B\?(.+)\?=/.exec(word)![1]!;
      // Each word must be valid UTF-8 on its own.
      const decoded = Buffer.from(inner, 'base64').toString('utf8');
      expect(decoded).not.toContain('�');
    }
    expect(decodeWords(encoded)).toBe(subject);
  });
});

describe('foldAscii', () => {
  it('folds long values at spaces under 78 chars per line', () => {
    const folded = foldAscii('Subject', 'word '.repeat(40).trim());
    for (const line of folded.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    expect(folded.replace(/\r\n /g, ' ')).toBe(`Subject: ${'word '.repeat(40).trim()}`);
  });
});

describe('buildMime', () => {
  it('builds a plain-text message with base64 UTF-8 body and no From by default', () => {
    const mime = buildMime({ ...base, subject: 'Hi', body: 'Line 1\nLine 2 ✓' });
    const h = headers(mime);
    expect(h['From']).toBeUndefined();
    expect(h['To']).toBe('alex@example.com');
    expect(h['Subject']).toBe('Hi');
    expect(h['Content-Type']).toBe('text/plain; charset=UTF-8');
    expect(h['Content-Transfer-Encoding']).toBe('base64');
    expect(h['Date']).toBe('Sat, 17 Oct 2026 10:00:00 +0000');
    const body = Buffer.from(mime.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString(
      'utf8',
    );
    expect(body).toBe('Line 1\r\nLine 2 ✓');
    expect(mime).not.toMatch(/[^\r]\n/);
  });

  it('adds From, Cc and Bcc when given', () => {
    const mime = buildMime({
      ...base,
      subject: 'x',
      from: 'alias@example.com',
      cc: ['c@example.com'],
      bcc: ['b@example.com'],
    });
    const h = headers(mime);
    expect(h['From']).toBe('alias@example.com');
    expect(h['Cc']).toBe('c@example.com');
    expect(h['Bcc']).toBe('b@example.com');
  });

  it('folds long recipient lists', () => {
    const to = Array.from({ length: 10 }, (_, i) => `person${i}@example.com`);
    const mime = buildMime({ ...base, subject: 'x', to });
    const head = mime.split('\r\n\r\n')[0]!;
    for (const line of head.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    expect(headers(mime)['To']!.replace(/\r\n /g, ' ').split(/,\s*/)).toEqual(to);
  });

  it('encodes a non-ASCII subject', () => {
    const mime = buildMime({ ...base, subject: 'Résumé 📎' });
    expect(decodeWords(headers(mime)['Subject']!)).toBe('Résumé 📎');
  });

  it('builds multipart/alternative for html with a generated text part', () => {
    const mime = buildMime({
      ...base,
      subject: 'x',
      format: 'html',
      body: '<h1>Title</h1><p>Hello <b>world</b></p>',
      boundary: 'BOUNDARY',
    });
    expect(headers(mime)['Content-Type']).toBe('multipart/alternative; boundary="BOUNDARY"');
    const parts = mime.split('--BOUNDARY').slice(1, 3);
    expect(parts[0]).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(parts[1]).toContain('Content-Type: text/html; charset=UTF-8');
    const decode = (p: string) =>
      Buffer.from(p.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8');
    expect(decode(parts[0]!)).toContain('Hello world');
    expect(decode(parts[0]!)).not.toContain('<b>');
    expect(decode(parts[1]!)).toContain('<b>world</b>');
    expect(mime.trimEnd().endsWith('--BOUNDARY--')).toBe(true);
  });

  it('refuses header values containing line breaks', () => {
    expect(() => buildMime({ ...base, subject: 'a\r\nBcc: evil@example.com' })).toThrow(
      /line break/,
    );
  });

  it('produces base64url for the Gmail raw field', () => {
    const raw = toBase64Url(buildMime({ ...base, subject: 'x' }));
    expect(raw).not.toMatch(/[+/=]/);
  });
});
