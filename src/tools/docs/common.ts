import type { docs_v1 } from '@googleapis/docs';
import * as z from 'zod';
import { SCOPES } from '../../config.js';
import { parseDocRef } from '../../lib/docRef.js';
import { googleErrorInfo, mapGoogleError } from '../../lib/errors.js';
import { checkDocAllowed } from '../../lib/guards.js';
import { retryableRead, withRetry } from '../../lib/retry.js';
import type { ToolContext } from '../../lib/tool.js';

export const documentField = z.string().describe('Google Doc URL or document ID.');
export const tabIdField = z
  .string()
  .optional()
  .describe(
    'Optional tab ID for docs that use tabs. Defaults to the tab in the URL, else the first tab.',
  );

/** Max times we retry after a revision conflict (PS §6.4: "up to 2 times"). */
export const MAX_CONFLICT_RETRIES = 2;

const BODY =
  'body(content(startIndex,endIndex,sectionBreak(sectionStyle(sectionType)),' +
  'paragraph(elements(textRun(content)),paragraphStyle(namedStyleType)),' +
  'table(rows,columns,tableRows(tableCells(startIndex,endIndex,' +
  'content(startIndex,endIndex,paragraph(elements(textRun(content)))))))))';

function tabMask(depth: number): string {
  const self = `tabProperties(tabId,title),documentTab(${BODY})`;
  return depth > 0 ? `${self},childTabs(${tabMask(depth - 1)})` : self;
}

/** Field mask keeping the documents.get payload small; covers child tabs three levels deep. */
export const DOC_FIELDS = `documentId,title,revisionId,tabs(${tabMask(2)})`;

export interface ResolvedDoc {
  documentId: string;
  tabId?: string;
}

export function resolveDoc(
  document: string,
  tabId: string | undefined,
  ctx: ToolContext,
): ResolvedDoc {
  const ref = parseDocRef(document);
  checkDocAllowed(ref.documentId, ctx.config.docs.allowedIds);
  const tab = tabId ?? ref.tabId;
  return { documentId: ref.documentId, ...(tab && { tabId: tab }) };
}

export async function docsErrorContext(ctx: ToolContext, documentId: string) {
  const accountEmail = await ctx.google.accountEmail();
  return { api: 'Google Docs' as const, docId: documentId, ...(accountEmail && { accountEmail }) };
}

export async function fetchDocument(
  ctx: ToolContext,
  documentId: string,
): Promise<docs_v1.Schema$Document> {
  await ctx.google.ensureScopes([SCOPES.documents]);
  const docs = await ctx.google.docs();
  try {
    const res = await withRetry(
      () =>
        docs.documents.get(
          { documentId, includeTabsContent: true, fields: DOC_FIELDS },
          ctx.google.requestOptions,
        ),
      {
        retryOn: retryableRead,
        onRetry: (_e, attempt, delayMs) =>
          ctx.logger.warn('retrying documents.get', { attempt, delayMs }),
      },
    );
    return res.data;
  } catch (err) {
    throw mapGoogleError(err, await docsErrorContext(ctx, documentId));
  }
}

/** True when batchUpdate failed because `writeControl.requiredRevisionId` is stale. */
export function isRevisionConflict(err: unknown): boolean {
  const info = googleErrorInfo(err);
  if (info.status !== 400 && info.status !== 409) return false;
  return (
    /revision/i.test(info.message ?? '') ||
    info.apiStatus === 'ABORTED' ||
    info.apiStatus === 'FAILED_PRECONDITION'
  );
}

export async function batchUpdate(
  ctx: ToolContext,
  documentId: string,
  requests: docs_v1.Schema$Request[],
  requiredRevisionId: string | null | undefined,
): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
  const docs = await ctx.google.docs();
  const res = await docs.documents.batchUpdate(
    {
      documentId,
      requestBody: {
        requests,
        ...(requiredRevisionId && { writeControl: { requiredRevisionId } }),
      },
    },
    ctx.google.requestOptions,
  );
  return res.data;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function backoff(attempt: number): Promise<void> {
  return sleep(Math.floor(Math.random() * Math.min(4000, 250 * 2 ** (attempt - 1))));
}
