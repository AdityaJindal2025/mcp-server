import type { docs_v1 } from '@googleapis/docs';
import * as z from 'zod';
import { sha256 } from '../../lib/audit.js';
import { docUrl } from '../../lib/docRef.js';
import { bodyEnd, lastTable, normalizeNewlines, selectTab } from '../../lib/docsIndex.js';
import { mapGoogleError, ToolError } from '../../lib/errors.js';
import { checkAppendSize } from '../../lib/guards.js';
import { stableStringify } from '../../lib/idempotency.js';
import type { ToolContext, ToolDefinition } from '../../lib/tool.js';
import { CLIENT_REQUEST_ID_DESCRIPTION } from '../gmail/compose.js';
import {
  batchUpdate,
  docsErrorContext,
  documentField,
  fetchDocument,
  isRevisionConflict,
  MAX_CONFLICT_RETRIES,
  resolveDoc,
  tabIdField,
} from './common.js';

const input = z.object({
  document: documentField,
  rows: z
    .array(z.array(z.string()))
    .min(1)
    .describe(
      'Table rows as arrays of cell strings; the first row is the header. Shorter rows are padded with empty cells.',
    ),
  bold_header: z.boolean().optional().describe('If true (default), the header row is bold.'),
  tab_id: tabIdField,
  client_request_id: z.string().max(128).optional().describe(CLIENT_REQUEST_ID_DESCRIPTION),
});

const output = z
  .object({
    document_id: z.string(),
    title: z.string(),
    url: z.string(),
    tab_id: z.string(),
    row_count: z.number().int(),
    column_count: z.number().int(),
    start_index: z.number().int(),
    end_index: z.number().int(),
    revision_id: z.string(),
  })
  .strict();

type Table = docs_v1.Schema$Table;

/** Pads every row to the widest row and normalizes newlines (PS §6.5). */
export function normalizeRows(rows: string[][]): string[][] {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => [...r.map(normalizeNewlines), ...Array<string>(cols - r.length).fill('')]);
}

function cellStarts(table: Table): number[][] {
  return (table.tableRows ?? []).map((row) =>
    (row.tableCells ?? []).map((cell) => {
      const start = cell.content?.[0]?.startIndex;
      if (typeof start !== 'number') throw new Error('table cell without a start index');
      return start;
    }),
  );
}

function isEmptyTable(table: Table, rows: number, cols: number): boolean {
  const trs = table.tableRows ?? [];
  if (trs.length !== rows) return false;
  return trs.every(
    (row) =>
      (row.tableCells ?? []).length === cols &&
      (row.tableCells ?? []).every((cell) =>
        (cell.content ?? []).every((el) =>
          (el.paragraph?.elements ?? []).every((e) => (e.textRun?.content ?? '') === '\n'),
        ),
      ),
  );
}

/**
 * Builds the fill requests in reverse cell order so earlier indices never
 * shift; each header cell is bolded right after its insert, while its range
 * is still valid.
 */
export function buildFillRequests(
  starts: number[][],
  rows: string[][],
  tabId: string | undefined,
  boldHeader: boolean,
): docs_v1.Schema$Request[] {
  const tab = tabId ? { tabId } : {};
  const requests: docs_v1.Schema$Request[] = [];
  for (let r = rows.length - 1; r >= 0; r--) {
    const row = rows[r]!;
    for (let c = row.length - 1; c >= 0; c--) {
      const text = row[c]!;
      if (!text) continue;
      const index = starts[r]![c]!;
      requests.push({ insertText: { location: { index, ...tab }, text } });
      if (r === 0 && boldHeader) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: index, endIndex: index + text.length, ...tab },
            textStyle: { bold: true },
            fields: 'bold',
          },
        });
      }
    }
  }
  return requests;
}

/**
 * Splitting the last paragraph to insert the table leaves an empty paragraph
 * after it that inherits that paragraph's heading/bullet style, so the next
 * append would come out styled. Reset it (same rationale as D5). These
 * requests run first in the fill batch, so their indices are pre-insert.
 */
export function trailingParagraphReset(
  body: docs_v1.Schema$Body,
  tableEnd: number | null | undefined,
  tabId: string | undefined,
): docs_v1.Schema$Request[] {
  if (typeof tableEnd !== 'number') return [];
  const next = (body.content ?? []).find((e) => e.startIndex === tableEnd);
  const text = (next?.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? '').join('');
  if (!next?.paragraph || text !== '\n') return [];
  const range = { startIndex: tableEnd, endIndex: tableEnd + 1, ...(tabId && { tabId }) };
  return [
    {
      updateParagraphStyle: {
        range,
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        fields: 'namedStyleType',
      },
    },
    { deleteParagraphBullets: { range } },
  ];
}

async function insertEmptyTable(
  ctx: ToolContext,
  documentId: string,
  tabId: string | undefined,
  rowCount: number,
  colCount: number,
): Promise<void> {
  for (let conflicts = 0; ;) {
    const doc = await fetchDocument(ctx, documentId);
    const tab = selectTab(doc, tabId);
    const index = Math.max(1, bodyEnd(tab.body) - 1);
    // Docs inserts a newline before the table, so it always starts on its own line.
    const request: docs_v1.Schema$Request = {
      insertTable: {
        rows: rowCount,
        columns: colCount,
        location: { index, ...(tab.tabId && { tabId: tab.tabId }) },
      },
    };
    try {
      await batchUpdate(ctx, documentId, [request], doc.revisionId);
      return;
    } catch (err) {
      if (isRevisionConflict(err) && ++conflicts <= MAX_CONFLICT_RETRIES) continue;
      if (isRevisionConflict(err)) {
        throw new ToolError(
          'CONCURRENT_EDITS',
          'The document changed while adding the table (someone else is editing it). Nothing was added; try again in a moment.',
        );
      }
      throw mapGoogleError(err, await docsErrorContext(ctx, documentId));
    }
  }
}

export const appendTableTool: ToolDefinition<typeof input, typeof output> = {
  name: 'gdocs_append_table',
  title: 'Append table to Google Doc',
  description:
    'Append a table to the end of an existing Google Doc; the first row is the header and is bold by default. Never modifies or removes existing content. Use gdocs_append_text for plain text.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input,
  output,
  idempotent: true,
  async handler(args, ctx) {
    const { maxTableRows, maxTableCols, maxAppendChars } = ctx.config.docs;
    const ref = resolveDoc(args.document, args.tab_id, ctx);
    const rows = normalizeRows(args.rows);
    const rowCount = rows.length;
    const colCount = rows[0]?.length ?? 0;
    if (colCount === 0)
      throw new ToolError('INVALID_INPUT', 'rows must contain at least one cell.');
    if (rowCount > maxTableRows || colCount > maxTableCols) {
      throw new ToolError(
        'TOO_LARGE',
        `Table is ${rowCount} rows x ${colCount} columns; the limit is ${maxTableRows} x ${maxTableCols}. Split it into smaller tables.`,
      );
    }
    const totalChars = rows.reduce((n, r) => n + r.reduce((m, c) => m + c.length, 0), 0);
    checkAppendSize(totalChars, maxAppendChars, 'Table text');
    const boldHeader = args.bold_header ?? true;
    const auditBase = {
      tool: 'gdocs_append_table' as const,
      transport: ctx.transport,
      doc_id: ref.documentId,
      row_count: rowCount,
      column_count: colCount,
      text_sha256: sha256(stableStringify(rows)),
      ...(args.client_request_id && { client_request_id: args.client_request_id }),
    };

    try {
      await insertEmptyTable(ctx, ref.documentId, ref.tabId, rowCount, colCount);
    } catch (err) {
      const mapped =
        err instanceof ToolError
          ? err
          : mapGoogleError(err, await docsErrorContext(ctx, ref.documentId));
      await ctx.audit.write({ ...auditBase, status: 'error', error_code: mapped.code });
      throw mapped;
    }

    // The table now exists; fill it. Never re-insert it on retry.
    for (let conflicts = 0; ;) {
      try {
        const doc = await fetchDocument(ctx, ref.documentId);
        const tab = selectTab(doc, ref.tabId);
        const el = lastTable(tab.body);
        if (!el?.table || !isEmptyTable(el.table, rowCount, colCount)) {
          throw new ToolError(
            'PARTIAL_WRITE',
            `An empty ${rowCount}x${colCount} table was added to the end of the document, but it could not be located to fill in. Check ${docUrl(ref.documentId, tab.tabId)}.`,
          );
        }
        const requests = [
          ...trailingParagraphReset(tab.body, el.endIndex, tab.tabId),
          ...buildFillRequests(cellStarts(el.table), rows, tab.tabId, boldHeader),
        ];
        let revision = doc.revisionId ?? '';
        if (requests.length > 0) {
          const res = await batchUpdate(ctx, ref.documentId, requests, doc.revisionId);
          revision = res.writeControl?.requiredRevisionId ?? '';
        }
        const startIndex = el.startIndex ?? 0;
        const endIndex = (el.endIndex ?? startIndex) + totalChars;
        await ctx.audit.write({
          ...auditBase,
          status: 'ok',
          ...(tab.tabId && { tab_id: tab.tabId }),
          revision_id: revision,
        });
        const title = doc.title ?? '';
        return {
          text: `Appended a ${rowCount}x${colCount} table to "${title}"${tab.title ? ` (tab "${tab.title}")` : ''}.`,
          structured: {
            document_id: ref.documentId,
            title,
            url: docUrl(ref.documentId, tab.tabId),
            tab_id: tab.tabId ?? '',
            row_count: rowCount,
            column_count: colCount,
            start_index: startIndex,
            end_index: endIndex,
            revision_id: revision,
          },
        };
      } catch (err) {
        if (isRevisionConflict(err) && ++conflicts <= MAX_CONFLICT_RETRIES) continue;
        const mapped =
          err instanceof ToolError
            ? err
            : new ToolError(
                'PARTIAL_WRITE',
                `An empty ${rowCount}x${colCount} table was added to the end of the document, but filling it failed: ${mapGoogleError(err, await docsErrorContext(ctx, ref.documentId)).message}`,
              );
        await ctx.audit.write({ ...auditBase, status: 'error', error_code: mapped.code });
        throw mapped;
      }
    }
  },
};
