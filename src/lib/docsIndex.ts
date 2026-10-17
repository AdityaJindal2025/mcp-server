/**
 * Pure index math over a Google Docs body. All indices are UTF-16 code units,
 * the same unit as JavaScript string length.
 */
import type { docs_v1 } from '@googleapis/docs';
import { ToolError } from './errors.js';

type Doc = docs_v1.Schema$Document;
type Body = docs_v1.Schema$Body;
type Element = docs_v1.Schema$StructuralElement;

export interface TabInfo {
  tabId?: string;
  title: string;
  body: Body;
}

/** Depth-first list of all tabs (including child tabs). Falls back to `doc.body` for tab-less responses. */
export function flattenTabs(doc: Doc): TabInfo[] {
  const out: TabInfo[] = [];
  const walk = (tabs: docs_v1.Schema$Tab[] | undefined) => {
    for (const tab of tabs ?? []) {
      const id = tab.tabProperties?.tabId ?? undefined;
      out.push({
        ...(id ? { tabId: id } : {}),
        title: tab.tabProperties?.title ?? '',
        body: tab.documentTab?.body ?? { content: [] },
      });
      walk(tab.childTabs ?? undefined);
    }
  };
  walk(doc.tabs ?? undefined);
  if (out.length === 0) out.push({ title: doc.title ?? '', body: doc.body ?? { content: [] } });
  return out;
}

export function selectTab(doc: Doc, requestedTabId?: string): TabInfo {
  const tabs = flattenTabs(doc);
  if (!requestedTabId) return tabs[0]!;
  const found = tabs.find((t) => t.tabId === requestedTabId);
  if (!found) {
    const available = tabs.map((t) => `${t.tabId ?? '(default)'} ("${t.title}")`).join(', ');
    throw new ToolError(
      'TAB_NOT_FOUND',
      `Tab "${requestedTabId}" not found in this document. Available tabs: ${available}.`,
    );
  }
  return found;
}

function content(body: Body): Element[] {
  return body.content ?? [];
}

/** End index of the body (exclusive). An empty doc body ends at 2. */
export function bodyEnd(body: Body): number {
  const els = content(body);
  return els[els.length - 1]?.endIndex ?? 1;
}

function paragraphText(p: docs_v1.Schema$Paragraph): string {
  return (p.elements ?? []).map((e) => e.textRun?.content ?? '').join('');
}

/** True when the last element is a paragraph containing only its trailing newline. */
export function lastParagraphIsEmpty(body: Body): boolean {
  const els = content(body);
  const last = els[els.length - 1];
  if (!last?.paragraph) return false;
  return paragraphText(last.paragraph) === '\n';
}

export interface AppendPlan {
  insertIndex: number;
  textToInsert: string;
  /** Inserted range [start, end), including any leading newline. */
  insertedStart: number;
  insertedEnd: number;
  /** True when a leading newline was added to start a new paragraph. */
  prefixed: boolean;
  /**
   * Start of the paragraphs that are entirely new (safe to style), or
   * undefined when the insertion creates no new paragraph.
   */
  newParagraphsStart?: number;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Plans an append at the end of the body. Inserting at `end - 1` lands inside
 * the last paragraph, so when `startOnNewLine` is set and that paragraph has
 * text, the insertion is prefixed with a newline (PS §6.4 gotcha).
 */
export function planAppend(body: Body, rawText: string, startOnNewLine: boolean): AppendPlan {
  const text = normalizeNewlines(rawText);
  const insertIndex = Math.max(1, bodyEnd(body) - 1);
  const lastEmpty = lastParagraphIsEmpty(body);
  const prefix = startOnNewLine && !lastEmpty;
  const textToInsert = prefix ? `\n${text}` : text;
  const insertedEnd = insertIndex + textToInsert.length;

  let newParagraphsStart: number | undefined;
  if (prefix) newParagraphsStart = insertIndex + 1;
  else if (lastEmpty) newParagraphsStart = insertIndex;
  else {
    // The first line merges into the existing last paragraph; only later lines are new.
    const firstBreak = text.indexOf('\n');
    if (firstBreak >= 0) newParagraphsStart = insertIndex + firstBreak + 1;
  }
  if (newParagraphsStart !== undefined && newParagraphsStart >= insertedEnd) {
    newParagraphsStart = undefined;
  }

  return {
    insertIndex,
    textToInsert,
    insertedStart: insertIndex,
    insertedEnd,
    prefixed: prefix,
    ...(newParagraphsStart !== undefined && { newParagraphsStart }),
  };
}

function elementText(el: Element): string {
  if (el.paragraph) return paragraphText(el.paragraph);
  if (el.table) {
    return (el.table.tableRows ?? [])
      .map((row) =>
        (row.tableCells ?? [])
          .map((cell) => (cell.content ?? []).map(elementText).join('').replace(/\n$/, ''))
          .join('\t'),
      )
      .join('\n')
      .concat('\n');
  }
  return '';
}

/** Plain text of a body: paragraphs as-is, table cells joined by tabs and rows by newlines. */
export function bodyText(body: Body): string {
  return content(body).map(elementText).join('');
}

/** Last `n` UTF-16 units of the body text, never splitting a surrogate pair. */
export function tailText(body: Body, n: number): string {
  if (n <= 0) return '';
  const text = bodyText(body);
  if (text.length <= n) return text;
  let start = text.length - n;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start++;
  return text.slice(start);
}

/** The last table element in a body, if any. */
export function lastTable(body: Body): docs_v1.Schema$StructuralElement | undefined {
  const els = content(body);
  for (let i = els.length - 1; i >= 0; i--) if (els[i]!.table) return els[i];
  return undefined;
}
