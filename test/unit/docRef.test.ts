import { describe, expect, it } from 'vitest';
import { docUrl, parseDocRef } from '../../src/lib/docRef.js';
import { ToolError } from '../../src/lib/errors.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg';

describe('parseDocRef', () => {
  it.each([
    [ID, { documentId: ID }],
    [`  ${ID}  `, { documentId: ID }],
    [`https://docs.google.com/document/d/${ID}/edit`, { documentId: ID }],
    [`https://docs.google.com/document/d/${ID}`, { documentId: ID }],
    [`https://docs.google.com/document/d/${ID}/`, { documentId: ID }],
    [`https://docs.google.com/document/d/${ID}/view`, { documentId: ID }],
    [`https://docs.google.com/document/d/${ID}/edit#heading=h.abc`, { documentId: ID }],
    [`https://docs.google.com/document/u/0/d/${ID}/edit`, { documentId: ID }],
    [`https://docs.google.com/document/u/2/d/${ID}/mobilebasic`, { documentId: ID }],
    [`http://docs.google.com/document/d/${ID}/edit`, { documentId: ID }],
    [`docs.google.com/document/d/${ID}/edit`, { documentId: ID }],
    [
      `https://docs.google.com/document/d/${ID}/edit?tab=t.abc123`,
      { documentId: ID, tabId: 't.abc123' },
    ],
    [
      `https://docs.google.com/document/d/${ID}/edit?usp=sharing&tab=t.0`,
      { documentId: ID, tabId: 't.0' },
    ],
    [
      `https://docs.google.com/document/u/0/d/${ID}/edit?tab=t.x#heading=h.1`,
      { documentId: ID, tabId: 't.x' },
    ],
  ])('parses %s', (input, expected) => {
    expect(parseDocRef(input)).toEqual(expected);
  });

  it.each([
    ['', /not a Google Doc URL or ID/],
    ['short-id', /not a Google Doc URL or ID/],
    [`https://docs.google.com.evil.com/document/d/${ID}/edit`, /not a Google Doc/],
    [`https://evil.com/document/d/${ID}`, /not a Google Doc/],
    [`https://docs.google.com/spreadsheets/d/${ID}/edit`, /Google Sheet, not a Doc/],
    [`https://docs.google.com/presentation/d/${ID}/edit`, /Slides deck/],
    [`https://docs.google.com/document/d/e/2PACX-${ID}/pub`, /Published-to-web/],
    [`ftp://docs.google.com/document/d/${ID}`, /not a Google Doc/],
    ['https://docs.google.com/document/d/abc/edit', /not a Google Doc/],
    ['https://docs.google.com/document/', /not a Google Doc/],
  ])('rejects %s', (input, message) => {
    expect(() => parseDocRef(input)).toThrow(message);
  });

  it('includes a valid example in the error', () => {
    try {
      parseDocRef('nope');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('INVALID_DOC_REF');
      expect((e as Error).message).toContain('https://docs.google.com/document/d/');
    }
  });

  it('truncates very long inputs in messages', () => {
    expect(() => parseDocRef('not a doc '.repeat(50))).toThrow(/\.\.\./);
  });
});

describe('docUrl', () => {
  it('builds edit URLs with optional tab', () => {
    expect(docUrl(ID)).toBe(`https://docs.google.com/document/d/${ID}/edit`);
    expect(docUrl(ID, 't.1')).toBe(`https://docs.google.com/document/d/${ID}/edit?tab=t.1`);
  });
});
