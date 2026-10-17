import type { docs_v1 } from '@googleapis/docs';
import * as z from 'zod';
import { sha256 } from '../../lib/audit.js';
import { docUrl } from '../../lib/docRef.js';
import {
  bodyText,
  normalizeNewlines,
  planAppend,
  selectTab,
  type AppendPlan,
} from '../../lib/docsIndex.js';
import { mapGoogleError, ToolError } from '../../lib/errors.js';
import { checkAppendSize } from '../../lib/guards.js';
import { retryableRead } from '../../lib/retry.js';
import type { ToolDefinition } from '../../lib/tool.js';
import { CLIENT_REQUEST_ID_DESCRIPTION } from '../gmail/compose.js';
import {
  backoff,
  batchUpdate,
  docsErrorContext,
  documentField,
  fetchDocument,
  isRevisionConflict,
  MAX_CONFLICT_RETRIES,
  resolveDoc,
  tabIdField,
} from './common.js';

const PARAGRAPH_STYLES = ['NORMAL_TEXT', 'TITLE', 'HEADING_1', 'HEADING_2', 'HEADING_3'] as const;
const MAX_TRANSIENT_ATTEMPTS = 3;

const input = z.object({
  document: documentField,
  text: z.string().describe('Text to append. Use \\n for line breaks.'),
  tab_id: tabIdField,
  start_on_new_line: z
    .boolean()
    .optional()
    .describe('If true (default), the text starts as a new paragraph.'),
  paragraph_style: z
    .enum(PARAGRAPH_STYLES)
    .optional()
    .describe('Optional style applied to the appended paragraphs (P1).'),
  client_request_id: z.string().max(128).optional().describe(CLIENT_REQUEST_ID_DESCRIPTION),
});

const output = z
  .object({
    document_id: z.string(),
    title: z.string(),
    url: z.string(),
    tab_id: z.string(),
    inserted_chars: z.number().int(),
    start_index: z.number().int(),
    end_index: z.number().int(),
    revision_id: z.string(),
  })
  .strict();

/**
 * Builds the batchUpdate requests. Every range starts at or after the
 * insertion point, so existing content is never touched (append-only).
 */
export function buildAppendRequests(
  plan: AppendPlan,
  tabId: string | undefined,
  style: (typeof PARAGRAPH_STYLES)[number] | undefined,
): docs_v1.Schema$Request[] {
  const tab = tabId ? { tabId } : {};
  const requests: docs_v1.Schema$Request[] = [
    { insertText: { location: { index: plan.insertIndex, ...tab }, text: plan.textToInsert } },
  ];
  if (plan.newParagraphsStart === undefined) return requests;
  const range = { startIndex: plan.newParagraphsStart, endIndex: plan.insertedEnd, ...tab };
  // D5: paragraphs we split off the last line would inherit its heading/bullet
  // style; reset them to normal text unless a style was requested.
  const effective = style ?? (plan.prefixed ? 'NORMAL_TEXT' : undefined);
  if (effective) {
    requests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle: { namedStyleType: effective },
        fields: 'namedStyleType',
      },
    });
  }
  if (plan.prefixed) requests.push({ deleteParagraphBullets: { range } });
  return requests;
}

export const appendTextTool: ToolDefinition<typeof input, typeof output> = {
  name: 'gdocs_append_text',
  title: 'Append to Google Doc',
  description:
    'Append text to the end of an existing Google Doc. Never modifies or removes existing content. Starts a new paragraph by default.',
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
    const ref = resolveDoc(args.document, args.tab_id, ctx);
    const text = normalizeNewlines(args.text);
    if (text.length === 0) throw new ToolError('INVALID_INPUT', 'text must not be empty.');
    checkAppendSize(text.length, ctx.config.docs.maxAppendChars);
    const startOnNewLine = args.start_on_new_line ?? true;
    const auditBase = {
      tool: 'gdocs_append_text' as const,
      transport: ctx.transport,
      doc_id: ref.documentId,
      text_sha256: sha256(text),
      ...(args.client_request_id && { client_request_id: args.client_request_id }),
    };

    let conflicts = 0;
    let transient = 0;
    // D4: after an ambiguous failure, the append may already have been applied.
    let ambiguous: { plan: AppendPlan; revisionId: string } | undefined;

    for (;;) {
      const doc = await fetchDocument(ctx, ref.documentId);
      const tab = selectTab(doc, ref.tabId);
      const title = doc.title ?? '';
      const revisionId = doc.revisionId ?? '';
      const done = (plan: AppendPlan, newRevision: string) => ({
        text: `Appended ${text.length.toLocaleString('en-US')} characters to "${title}"${tab.title ? ` (tab "${tab.title}")` : ''}.`,
        structured: {
          document_id: ref.documentId,
          title,
          url: docUrl(ref.documentId, tab.tabId),
          tab_id: tab.tabId ?? '',
          inserted_chars: plan.textToInsert.length,
          start_index: plan.insertedStart,
          end_index: plan.insertedEnd,
          revision_id: newRevision,
        },
      });

      if (
        ambiguous &&
        revisionId !== ambiguous.revisionId &&
        bodyText(tab.body).endsWith(`${ambiguous.plan.textToInsert}\n`)
      ) {
        ctx.logger.info('append already applied after ambiguous failure', {
          doc_id: ref.documentId,
        });
        await ctx.audit.write({
          ...auditBase,
          status: 'ok',
          ...(tab.tabId && { tab_id: tab.tabId }),
          revision_id: revisionId,
          inserted_chars: ambiguous.plan.textToInsert.length,
        });
        return done(ambiguous.plan, revisionId);
      }

      const plan = planAppend(tab.body, text, startOnNewLine);
      const requests = buildAppendRequests(plan, tab.tabId, args.paragraph_style);
      try {
        const res = await batchUpdate(ctx, ref.documentId, requests, revisionId);
        const newRevision = res.writeControl?.requiredRevisionId ?? '';
        await ctx.audit.write({
          ...auditBase,
          status: 'ok',
          ...(tab.tabId && { tab_id: tab.tabId }),
          revision_id: newRevision,
          inserted_chars: plan.textToInsert.length,
        });
        return done(plan, newRevision);
      } catch (err) {
        if (isRevisionConflict(err)) {
          conflicts++;
          ctx.logger.info('revision conflict on append', { doc_id: ref.documentId, conflicts });
          if (conflicts > MAX_CONFLICT_RETRIES) {
            await ctx.audit.write({
              ...auditBase,
              status: 'error',
              error_code: 'CONCURRENT_EDITS',
            });
            throw new ToolError(
              'CONCURRENT_EDITS',
              'The document changed while appending (someone else is editing it). Nothing was appended; try again in a moment.',
            );
          }
          continue;
        }
        if (retryableRead(err) && ++transient < MAX_TRANSIENT_ATTEMPTS) {
          ambiguous = { plan, revisionId };
          ctx.logger.warn('transient error on append; re-reading before retry', {
            attempt: transient,
          });
          await backoff(transient);
          continue;
        }
        const mapped = mapGoogleError(err, await docsErrorContext(ctx, ref.documentId));
        await ctx.audit.write({ ...auditBase, status: 'error', error_code: mapped.code });
        throw mapped;
      }
    }
  },
};
