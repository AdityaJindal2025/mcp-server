import { afterEach, expect, it } from 'vitest';
import { para } from '../helpers/fakeDocs.js';
import { ACCOUNT, makeHarness, textOf, type Harness } from '../helpers/harness.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg';
let h: Harness;
afterEach(async () => h?.close());

it('returns title, tabs, end index and tail text', async () => {
  h = await makeHarness();
  h.docs.add(ID, 'Changelog', [
    { tabId: 't.0', title: 'Main', body: [para('# Changelog'), para('v1.0 released')] },
    { tabId: 't.notes', title: 'Notes', body: [para('notes here')] },
  ]);
  const r = await h.call('gdocs_get_document_info', {
    document: `https://docs.google.com/document/d/${ID}/edit`,
    tail_chars: 8,
  });
  expect(r.isError).toBeFalsy();
  expect(r.structuredContent).toEqual({
    document_id: ID,
    title: 'Changelog',
    url: `https://docs.google.com/document/d/${ID}/edit`,
    revision_id: 'rev-1',
    tabs: [
      { tab_id: 't.0', title: 'Main' },
      { tab_id: 't.notes', title: 'Notes' },
    ],
    end_index: 1 + 12 + 14,
    tail_text: 'released\n'.slice(-8),
  });
  expect(textOf(r)).toBe('"Changelog" (2 tabs). Ends with: "eleased\\n"');
});

it('uses the tab from the URL and defaults tail to 500', async () => {
  h = await makeHarness();
  h.docs.add(ID, 'D', [
    { body: [para('a')] },
    { tabId: 't.x', title: 'X', body: [para('x'.repeat(600))] },
  ]);
  const r = await h.call('gdocs_get_document_info', {
    document: `https://docs.google.com/document/d/${ID}/edit?tab=t.x`,
  });
  const s = r.structuredContent as { tail_text: string; end_index: number; url: string };
  expect(s.tail_text).toHaveLength(500);
  expect(s.end_index).toBe(602);
  expect(s.url).toContain('?tab=t.x');
});

it('validates tail_chars bounds', async () => {
  h = await makeHarness();
  h.docs.add(ID, 'D', [{ body: [para('a')] }]);
  const r = await h.call('gdocs_get_document_info', { document: ID, tail_chars: 6000 });
  expect(textOf(r)).toBe('tail_chars must be between 0 and 5000 (got 6000).');
});

it('rejects invalid references with an example', async () => {
  h = await makeHarness();
  const r = await h.call('gdocs_get_document_info', { document: 'https://example.com/foo' });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toMatch(/https:\/\/docs\.google\.com\/document\/d\//);
});

it('maps 403 and 404', async () => {
  h = await makeHarness();
  h.docs.add(ID, 'D', [{ body: [para('a')] }]);
  h.docs.denied.add(ID);
  expect(textOf(await h.call('gdocs_get_document_info', { document: ID }))).toBe(
    `The connected Google account (${ACCOUNT}) does not have edit access to this document. Share it with ${ACCOUNT} as an Editor and retry.`,
  );
  const missing = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
  expect(textOf(await h.call('gdocs_get_document_info', { document: missing }))).toMatch(
    /Document Z+ was not found/,
  );
});

it('applies the doc allowlist to reads', async () => {
  h = await makeHarness({ env: { DOCS_ALLOWED_IDS: 'otherdocid000000000000000000' } });
  h.docs.add(ID, 'D', [{ body: [para('a')] }]);
  const r = await h.call('gdocs_get_document_info', { document: ID });
  expect(textOf(r)).toBe(`This server is not allowed to access document ${ID}.`);
  expect(h.docs.getCalls).toBe(0);
});

it('retries a 503 on read', async () => {
  h = await makeHarness();
  h.docs.add(ID, 'D', [{ body: [para('a')] }]);
  h.docs.failures.push({ op: 'get', status: 503 });
  const r = await h.call('gdocs_get_document_info', { document: ID });
  expect(r.isError).toBeFalsy();
  expect(h.docs.getCalls).toBe(2);
});
