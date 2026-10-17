import { afterEach, describe, expect, it } from 'vitest';
import { para, plainText, type Table } from '../helpers/fakeDocs.js';
import { makeHarness, textOf, type Harness } from '../helpers/harness.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg';
let h: Harness;
afterEach(async () => h?.close());

const rows = [
  ['Test', 'Result', 'Notes'],
  ['login', 'pass', ''],
  ['checkout', 'fail', 'timeout'],
  ['search', 'pass'],
  ['profile', 'pass', 'ok'],
  ['logout', 'pass', 'ok'],
];

describe('gdocs_append_table', () => {
  it('appends a filled table after existing content with a bold header', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'QA tracker', [{ body: [para('QA results')] }]);
    const r = await h.call('gdocs_append_table', { document: ID, rows });
    expect(r.isError).toBeFalsy();
    const b = h.docs.tab(ID).body;
    expect(b[0]).toMatchObject({ text: 'QA results\n' });
    const table = b.find((e): e is Table => e.kind === 't')!;
    expect(table.rows).toHaveLength(6);
    expect(table.rows.map((row) => row.map((c) => c[0]!.text.replace(/\n$/, '')))).toEqual([
      ['Test', 'Result', 'Notes'],
      ['login', 'pass', ''],
      ['checkout', 'fail', 'timeout'],
      ['search', 'pass', ''],
      ['profile', 'pass', 'ok'],
      ['logout', 'pass', 'ok'],
    ]);
    const header = table.rows[0]!.map((c) => c[0]!);
    for (const p of header) expect(p.bold.slice(0, p.text.length - 1).every(Boolean)).toBe(true);
    expect(table.rows[1]![0]![0]!.bold.some(Boolean)).toBe(false);
    expect(r.structuredContent).toMatchObject({
      document_id: ID,
      title: 'QA tracker',
      tab_id: 't.0',
      row_count: 6,
      column_count: 3,
      revision_id: 'rev-3',
    });
    expect(textOf(r)).toBe('Appended a 6x3 table to "QA tracker" (tab "Tab 1").');
    expect(h.audit.events[0]).toMatchObject({
      tool: 'gdocs_append_table',
      status: 'ok',
      row_count: 6,
      column_count: 3,
    });
  });

  it('supports bold_header=false and an empty doc', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('')] }]);
    await h.call('gdocs_append_table', { document: ID, rows: [['a', 'b']], bold_header: false });
    const table = h.docs.tab(ID).body.find((e): e is Table => e.kind === 't')!;
    expect(table.rows[0]![0]![0]!.bold.some(Boolean)).toBe(false);
    expect(plainText(h.docs.tab(ID).body)).toBe('\na\tb\n\n');
  });

  it('enforces size limits', async () => {
    h = await makeHarness({ env: { DOCS_MAX_TABLE_ROWS: '2', DOCS_MAX_TABLE_COLS: '2' } });
    h.docs.add(ID, 'D', [{ body: [para('')] }]);
    const r = await h.call('gdocs_append_table', { document: ID, rows: [['a'], ['b'], ['c']] });
    expect(textOf(r)).toBe(
      'Table is 3 rows x 1 columns; the limit is 2 x 2. Split it into smaller tables.',
    );
    expect(textOf(await h.call('gdocs_append_table', { document: ID, rows: [[]] }))).toBe(
      'rows must contain at least one cell.',
    );
    expect(h.docs.batchCalls).toHaveLength(0);
  });

  it('retries the fill after a conflict without inserting a second table', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('x')] }]);
    let n = 0;
    h.docs.hooks.beforeBatch = (doc) => {
      if (n++ === 1) doc.revision++; // conflict on the first fill attempt
    };
    const r = await h.call('gdocs_append_table', { document: ID, rows: [['h'], ['v']] });
    expect(r.isError).toBeFalsy();
    expect(h.docs.tab(ID).body.filter((e) => e.kind === 't')).toHaveLength(1);
    expect(h.docs.batchCalls.filter((c) => c.requests?.[0]?.insertTable)).toHaveLength(1);
  });

  it('reports a partial write if filling fails', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('x')] }]);
    // First batch (insertTable) succeeds, the fill gets a 403.
    let calls = 0;
    const orig = h.docs.batchUpdate.bind(h.docs);
    h.docs.batchUpdate = (id, req) =>
      ++calls === 2
        ? {
            status: 403,
            body: { error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } },
          }
        : orig(id, req);
    const r = await h.call('gdocs_append_table', { document: ID, rows: [['h']] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(
      /An empty 1x1 table was added .* but filling it failed: The connected Google account/,
    );
    expect(h.audit.events.at(-1)).toMatchObject({ status: 'error', error_code: 'PARTIAL_WRITE' });
  });

  it('maps errors before the table is inserted', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('x')] }]);
    h.docs.hooks.beforeBatch = (doc) => void doc.revision++;
    const r = await h.call('gdocs_append_table', { document: ID, rows: [['h']] });
    expect(textOf(r)).toMatch(/document changed while adding the table/);
    expect(h.docs.tab(ID).body.some((e) => e.kind === 't')).toBe(false);
  });
});

it('resets the empty paragraph after the table so later appends are not headings (found in live test)', async () => {
  h = await makeHarness();
  h.docs.add(ID, 'D', [{ body: [para('Section', 'HEADING_3', true)] }]);
  await h.call('gdocs_append_table', { document: ID, rows: [['h'], ['v']] });
  const b = h.docs.tab(ID).body;
  expect(b[0]).toMatchObject({ text: 'Section\n', style: 'HEADING_3', bullet: true });
  expect(b.at(-1)).toMatchObject({ text: '\n', style: 'NORMAL_TEXT', bullet: false });
  await h.call('gdocs_append_text', { document: ID, text: 'after table' });
  expect(h.docs.tab(ID).body.at(-1)).toMatchObject({
    text: 'after table\n',
    style: 'NORMAL_TEXT',
    bullet: false,
  });
});
