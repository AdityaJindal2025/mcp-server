import * as z from 'zod';
import { docUrl } from '../../lib/docRef.js';
import { bodyEnd, flattenTabs, selectTab, tailText } from '../../lib/docsIndex.js';
import { ToolError } from '../../lib/errors.js';
import type { ToolDefinition } from '../../lib/tool.js';
import { documentField, fetchDocument, resolveDoc } from './common.js';

export const MAX_TAIL_CHARS = 5000;
const DEFAULT_TAIL_CHARS = 500;

const input = z.object({
  document: documentField,
  tail_chars: z
    .number()
    .int()
    .optional()
    .describe('How many characters from the end of the doc to return (default 500, max 5000).'),
});

const output = z
  .object({
    document_id: z.string(),
    title: z.string(),
    url: z.string(),
    revision_id: z.string(),
    tabs: z.array(z.object({ tab_id: z.string(), title: z.string() }).strict()),
    end_index: z.number().int(),
    tail_text: z.string(),
  })
  .strict();

export const getDocumentInfoTool: ToolDefinition<typeof input, typeof output> = {
  name: 'gdocs_get_document_info',
  title: 'Get Google Doc info',
  description:
    'Get the title, tabs and the last part of an existing Google Doc. Use this to confirm you have the right document before appending to it. Returns the last 500 characters by default.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input,
  output,
  async handler(args, ctx) {
    const tailChars = args.tail_chars ?? DEFAULT_TAIL_CHARS;
    if (tailChars < 0 || tailChars > MAX_TAIL_CHARS) {
      throw new ToolError(
        'INVALID_INPUT',
        `tail_chars must be between 0 and ${MAX_TAIL_CHARS} (got ${tailChars}).`,
      );
    }
    const ref = resolveDoc(args.document, undefined, ctx);
    const doc = await fetchDocument(ctx, ref.documentId);
    const tab = selectTab(doc, ref.tabId);
    const tabs = flattenTabs(doc).map((t) => ({ tab_id: t.tabId ?? '', title: t.title }));
    const tail = tailText(tab.body, tailChars);
    const title = doc.title ?? '';
    const snippet = tail.length > 120 ? `…${tail.slice(-120)}` : tail;
    return {
      text: `"${title}" (${tabs.length} tab${tabs.length === 1 ? '' : 's'}). Ends with: "${snippet.replace(/\n/g, '\\n')}"`,
      structured: {
        document_id: doc.documentId ?? ref.documentId,
        title,
        url: docUrl(ref.documentId, ref.tabId),
        revision_id: doc.revisionId ?? '',
        tabs,
        end_index: bodyEnd(tab.body),
        tail_text: tail,
      },
    };
  },
};
