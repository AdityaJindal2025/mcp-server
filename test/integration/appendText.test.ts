import { afterEach, describe, expect, it } from 'vitest';
import { para, plainText } from '../helpers/fakeDocs.js';
import { ACCOUNT, makeHarness, textOf, type Harness } from '../helpers/harness.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg';
let h: Harness;
afterEach(async () => h?.close());

const body = () => h.docs.tab(ID).body;

describe('gdocs_append_text', () => {
  it('starts a new paragraph when the last line has text (no merge)', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'Changelog', [{ body: [para('Existing line')] }]);
    const r = await h.call('gdocs_append_text', { document: ID, text: 'v1.1: fixes' });
    expect(r.isError).toBeFalsy();
    expect(plainText(body())).toBe('Existing line\nv1.1: fixes\n');
    expect(r.structuredContent).toEqual({
      document_id: ID,
      title: 'Changelog',
      url: `https://docs.google.com/document/d/${ID}/edit?tab=t.0`,
      tab_id: 't.0',
      inserted_chars: 12,
      start_index: 14,
      end_index: 26,
      revision_id: 'rev-2',
    });
    expect(textOf(r)).toBe('Appended 11 characters to "Changelog" (tab "Tab 1").');
    const req = h.docs.batchCalls[0]!;
    expect(req.writeControl).toEqual({ requiredRevisionId: 'rev-1' });
    expect(req.requests![0]).toEqual({
      insertText: { location: { index: 14, tabId: 't.0' }, text: '\nv1.1: fixes' },
    });
  });

  it('appends to an empty doc without a leading blank line', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'Empty', [{ body: [para('')] }]);
    const r = await h.call('gdocs_append_text', { document: ID, text: 'First line' });
    expect(r.isError).toBeFalsy();
    expect(plainText(body())).toBe('First line\n');
  });

  it('leaves existing content byte-for-byte unchanged before the insertion point', async () => {
    h = await makeHarness();
    const original = [
      para('Title', 'HEADING_1'),
      para('Body with émoji 🚀 and\ttabs'),
      para('Last'),
    ];
    h.docs.add(ID, 'D', [{ body: original.map((p) => ({ ...p })) }]);
    const before = plainText(body());
    const styles = body().map((e) => (e.kind === 'p' ? e.style : ''));
    await h.call('gdocs_append_text', {
      document: ID,
      text: 'line A\nline B\n',
      paragraph_style: 'HEADING_2',
    });
    const after = plainText(body());
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe('line A\nline B\n\n');
    expect(
      body()
        .slice(0, 3)
        .map((e) => (e.kind === 'p' ? e.style : '')),
    ).toEqual(styles);
  });

  it('start_on_new_line=false continues the last line and never restyles it', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('Heading', 'HEADING_1')] }]);
    await h.call('gdocs_append_text', {
      document: ID,
      text: ' (cont.)',
      start_on_new_line: false,
      paragraph_style: 'TITLE',
    });
    expect(plainText(body())).toBe('Heading (cont.)\n');
    expect(body()[0]).toMatchObject({ style: 'HEADING_1' });
    expect(h.docs.batchCalls[0]!.requests).toHaveLength(1);
  });

  it('applies paragraph_style only to the appended paragraphs', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('Intro')] }]);
    await h.call('gdocs_append_text', {
      document: ID,
      text: 'Release 2\nDetails',
      paragraph_style: 'HEADING_2',
    });
    expect(body().map((e) => (e.kind === 'p' ? [e.text, e.style] : []))).toEqual([
      ['Intro\n', 'NORMAL_TEXT'],
      ['Release 2\n', 'HEADING_2'],
      ['Details\n', 'HEADING_2'],
    ]);
  });

  it('D5: appended paragraphs do not inherit a heading or bullet from the last line', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('Item', 'HEADING_3', true)] }]);
    await h.call('gdocs_append_text', { document: ID, text: 'Plain' });
    expect(body()[0]).toMatchObject({ text: 'Item\n', style: 'HEADING_3', bullet: true });
    expect(body()[1]).toMatchObject({ text: 'Plain\n', style: 'NORMAL_TEXT', bullet: false });
  });

  it('respects an explicit tab_id and the URL tab', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [
      {
        tabId: 't.0',
        title: 'A',
        body: [para('a')],
        children: [{ tabId: 't.kid', title: 'Kid', body: [para('k')], children: [] }],
      },
      { tabId: 't.b', title: 'B', body: [para('b')] },
    ]);
    await h.call('gdocs_append_text', {
      document: `https://docs.google.com/document/d/${ID}/edit?tab=t.b`,
      text: 'from url',
    });
    await h.call('gdocs_append_text', {
      document: `https://docs.google.com/document/d/${ID}/edit?tab=t.b`,
      text: 'child',
      tab_id: 't.kid',
    });
    expect(plainText(h.docs.tab(ID, 't.b').body)).toBe('b\nfrom url\n');
    expect(plainText(h.docs.tab(ID, 't.kid').body)).toBe('k\nchild\n');
    expect(plainText(h.docs.tab(ID, 't.0').body)).toBe('a\n');
  });

  it('reports unknown tabs', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ tabId: 't.0', title: 'A', body: [para('a')] }]);
    const r = await h.call('gdocs_append_text', { document: ID, text: 'x', tab_id: 't.nope' });
    expect(textOf(r)).toBe('Tab "t.nope" not found in this document. Available tabs: t.0 ("A").');
  });

  it('retries after a revision conflict and then succeeds', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('a')] }]);
    let edits = 0;
    h.docs.hooks.beforeBatch = (doc) => {
      if (edits++ === 0) {
        doc.tabs[0]!.body.push(para('someone else'));
        doc.revision++;
      }
    };
    const r = await h.call('gdocs_append_text', { document: ID, text: 'mine' });
    expect(r.isError).toBeFalsy();
    expect(plainText(body())).toBe('a\nsomeone else\nmine\n');
    expect(h.docs.batchCalls).toHaveLength(2);
  });

  it('gives up after 3 conflicting attempts without appending', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('a')] }]);
    h.docs.hooks.beforeBatch = (doc) => void doc.revision++;
    const r = await h.call('gdocs_append_text', { document: ID, text: 'mine' });
    expect(textOf(r)).toMatch(/document changed while appending.*Nothing was appended/);
    expect(h.docs.batchCalls).toHaveLength(3);
    expect(plainText(body())).toBe('a\n');
    expect(h.audit.events.at(-1)).toMatchObject({
      status: 'error',
      error_code: 'CONCURRENT_EDITS',
    });
  });

  it('D4: does not append twice when a write succeeded but the response failed', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('a')] }]);
    h.docs.failures.push({ op: 'batchUpdate', status: 503, apply: true });
    const r = await h.call('gdocs_append_text', { document: ID, text: 'once' });
    expect(r.isError).toBeFalsy();
    expect(plainText(body())).toBe('a\nonce\n');
    expect(h.docs.batchCalls).toHaveLength(1);
  });

  it('retries a 503 that did not apply', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('a')] }]);
    h.docs.failures.push({ op: 'batchUpdate', status: 503 });
    const r = await h.call('gdocs_append_text', { document: ID, text: 'once' });
    expect(r.isError).toBeFalsy();
    expect(plainText(body())).toBe('a\nonce\n');
  });

  it('gives up after repeated 5xx', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('a')] }]);
    for (let i = 0; i < 3; i++) h.docs.failures.push({ op: 'batchUpdate', status: 500 });
    const r = await h.call('gdocs_append_text', { document: ID, text: 'x' });
    expect(textOf(r)).toMatch(/Google Docs did not respond successfully/);
  });

  it('returns an edit-access error naming the account', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('a')] }]);
    h.docs.denied.add(ID);
    const r = await h.call('gdocs_append_text', { document: ID, text: 'x' });
    expect(textOf(r)).toContain(
      `The connected Google account (${ACCOUNT}) does not have edit access to this document.`,
    );
  });

  it('enforces DOCS_MAX_APPEND_CHARS and rejects empty text', async () => {
    h = await makeHarness({ env: { DOCS_MAX_APPEND_CHARS: '10' } });
    h.docs.add(ID, 'D', [{ body: [para('a')] }]);
    expect(
      textOf(await h.call('gdocs_append_text', { document: ID, text: 'x'.repeat(11) })),
    ).toMatch(/limit is 10/);
    expect(textOf(await h.call('gdocs_append_text', { document: ID, text: '' }))).toBe(
      'text must not be empty.',
    );
    expect(h.docs.batchCalls).toHaveLength(0);
  });

  it('audits the hash and length, never the text', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('a')] }]);
    await h.call('gdocs_append_text', { document: ID, text: 'secret plans' });
    expect(h.audit.events[0]).toMatchObject({
      tool: 'gdocs_append_text',
      status: 'ok',
      doc_id: ID,
      tab_id: 't.0',
      revision_id: 'rev-2',
      inserted_chars: 13,
    });
    expect(JSON.stringify(h.audit.events)).not.toContain('secret plans');
    expect(h.logs.lines.join('')).not.toContain('secret plans');
  });

  it('client_request_id prevents a duplicate append on agent retry', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('a')] }]);
    await h.call('gdocs_append_text', { document: ID, text: 'once', client_request_id: 'x1' });
    await h.call('gdocs_append_text', { document: ID, text: 'once', client_request_id: 'x1' });
    expect(plainText(body())).toBe('a\nonce\n');
  });
});
