/**
 * In-memory model of the parts of Google Docs the server uses, exposed over
 * nock so tests exercise the real googleapis request building. Index rules
 * mirror the API: a section break occupies [0,1), paragraphs include their
 * trailing newline, tables and rows and cells each take one structural index.
 */
import type { docs_v1 } from '@googleapis/docs';

export interface Para {
  kind: 'p';
  text: string;
  style: string;
  bullet: boolean;
  bold: boolean[];
}
export interface Table {
  kind: 't';
  rows: Para[][][];
}
type El = Para | Table;

export interface FakeTab {
  tabId: string;
  title: string;
  body: El[];
  children: FakeTab[];
}

export interface FakeDoc {
  id: string;
  title: string;
  revision: number;
  tabs: FakeTab[];
}

export const para = (text: string, style = 'NORMAL_TEXT', bullet = false): Para => ({
  kind: 'p',
  text: text.endsWith('\n') ? text : `${text}\n`,
  style,
  bullet,
  bold: Array<boolean>(text.endsWith('\n') ? text.length : text.length + 1).fill(false),
});

const elSize = (el: El): number =>
  el.kind === 'p'
    ? el.text.length
    : 1 +
      el.rows.reduce(
        (n, row) =>
          n + 1 + row.reduce((m, cell) => m + 1 + cell.reduce((k, p) => k + p.text.length, 0), 0),
        0,
      );

interface Located {
  list: Para[] | El[];
  idx: number;
  start: number;
  para: Para;
  inCell: boolean;
}

/** Walks every paragraph (body and table cells) with its start index. */
function walk(body: El[], fn: (l: Located) => boolean | void): void {
  let pos = 1;
  for (let i = 0; i < body.length; i++) {
    const el = body[i]!;
    if (el.kind === 'p') {
      if (fn({ list: body, idx: i, start: pos, para: el, inCell: false })) return;
      pos += el.text.length;
      continue;
    }
    pos += 1; // table start
    for (const row of el.rows) {
      pos += 1; // row start
      for (const cell of row) {
        pos += 1; // cell start
        for (let j = 0; j < cell.length; j++) {
          if (fn({ list: cell, idx: j, start: pos, para: cell[j]!, inCell: true })) return;
          pos += cell[j]!.text.length;
        }
      }
    }
  }
}

function locate(body: El[], index: number): Located {
  let found: Located | undefined;
  walk(body, (l) => {
    if (index >= l.start && index < l.start + l.para.text.length) {
      found = l;
      return true;
    }
    return false;
  });
  if (!found)
    throw new FakeApiError(
      400,
      `Index ${index} must be less than the end index of the referenced segment.`,
    );
  return found;
}

export class FakeApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly apiStatus = status === 400 ? 'INVALID_ARGUMENT' : 'ERROR',
  ) {
    super(message);
  }
}

function insertText(body: El[], index: number, text: string): void {
  const l = locate(body, index);
  const off = index - l.start;
  const p = l.para;
  const combined = p.text.slice(0, off) + text + p.text.slice(off);
  const bold = [
    ...p.bold.slice(0, off),
    ...Array<boolean>(text.length).fill(false),
    ...p.bold.slice(off),
  ];
  const pieces: Para[] = [];
  let startChar = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] === '\n') {
      pieces.push({
        kind: 'p',
        text: combined.slice(startChar, i + 1),
        style: p.style,
        bullet: p.bullet,
        bold: bold.slice(startChar, i + 1),
      });
      startChar = i + 1;
    }
  }
  (l.list as El[]).splice(l.idx, 1, ...pieces);
}

function insertTable(body: El[], index: number, rows: number, cols: number): void {
  const l = locate(body, index);
  if (l.inCell)
    throw new FakeApiError(400, 'Tables cannot be inserted inside tables in this fake.');
  const off = index - l.start;
  const p = l.para;
  const before: Para = {
    ...p,
    text: `${p.text.slice(0, off)}\n`,
    bold: [...p.bold.slice(0, off), false],
  };
  const after: Para = { ...p, text: p.text.slice(off), bold: p.bold.slice(off) };
  const table: Table = {
    kind: 't',
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => [para('')])),
  };
  body.splice(l.idx, 1, before, table, after);
}

function forRange(body: El[], start: number, end: number, fn: (p: Para, l: Located) => void): void {
  walk(body, (l) => {
    if (l.start < end && l.start + l.para.text.length > start) fn(l.para, l);
  });
}

function toApiParagraph(p: Para, start: number): docs_v1.Schema$StructuralElement {
  return {
    startIndex: start,
    endIndex: start + p.text.length,
    paragraph: {
      elements: [
        { startIndex: start, endIndex: start + p.text.length, textRun: { content: p.text } },
      ],
      paragraphStyle: { namedStyleType: p.style },
      ...(p.bullet && { bullet: { listId: 'l1' } }),
    },
  };
}

export function toApiBody(body: El[]): docs_v1.Schema$Body {
  const content: docs_v1.Schema$StructuralElement[] = [
    { endIndex: 1, sectionBreak: { sectionStyle: { sectionType: 'CONTINUOUS' } } },
  ];
  let pos = 1;
  for (const el of body) {
    if (el.kind === 'p') {
      content.push(toApiParagraph(el, pos));
      pos += el.text.length;
      continue;
    }
    const tStart = pos;
    pos += 1;
    const tableRows = el.rows.map((row) => {
      const rStart = pos;
      pos += 1;
      const tableCells = row.map((cell) => {
        const cStart = pos;
        pos += 1;
        const cellContent = cell.map((p) => {
          const e = toApiParagraph(p, pos);
          pos += p.text.length;
          return e;
        });
        return { startIndex: cStart, endIndex: pos, content: cellContent };
      });
      return { startIndex: rStart, endIndex: pos, tableCells };
    });
    content.push({
      startIndex: tStart,
      endIndex: pos,
      table: { rows: el.rows.length, columns: el.rows[0]?.length ?? 0, tableRows },
    });
  }
  return { content };
}

export function plainText(body: El[]): string {
  return body
    .map((el) =>
      el.kind === 'p'
        ? el.text
        : el.rows
            .map((r) =>
              r
                .map((c) =>
                  c
                    .map((p) => p.text)
                    .join('')
                    .replace(/\n$/, ''),
                )
                .join('\t'),
            )
            .join('\n') + '\n',
    )
    .join('');
}

export interface BatchHooks {
  /** Runs before the revision check; use it to simulate concurrent edits. */
  beforeBatch?: (doc: FakeDoc) => void;
}

export class FakeDocsStore {
  docs = new Map<string, FakeDoc>();
  denied = new Set<string>();
  batchCalls: docs_v1.Schema$BatchUpdateDocumentRequest[] = [];
  getCalls = 0;
  hooks: BatchHooks = {};
  /** Queued failures: `apply` means the write succeeds but the response still fails (ambiguous). */
  failures: { op: 'get' | 'batchUpdate'; status: number; apply?: boolean; body?: unknown }[] = [];

  add(
    id: string,
    title: string,
    tabs: { tabId?: string; title?: string; body: El[]; children?: FakeTab[] }[],
  ): FakeDoc {
    const doc: FakeDoc = {
      id,
      title,
      revision: 1,
      tabs: tabs.map((t, i) => ({
        tabId: t.tabId ?? `t.${i}`,
        title: t.title ?? `Tab ${i + 1}`,
        body: t.body,
        children: t.children ?? [],
      })),
    };
    this.docs.set(id, doc);
    return doc;
  }

  tab(id: string, tabId?: string): FakeTab {
    const doc = this.docs.get(id)!;
    const all: FakeTab[] = [];
    const flat = (ts: FakeTab[]) => ts.forEach((t) => (all.push(t), flat(t.children)));
    flat(doc.tabs);
    return tabId ? all.find((t) => t.tabId === tabId)! : all[0]!;
  }

  private access(id: string): FakeDoc {
    if (this.denied.has(id))
      throw new FakeApiError(403, 'The caller does not have permission', 'PERMISSION_DENIED');
    const doc = this.docs.get(id);
    if (!doc) throw new FakeApiError(404, 'Requested entity was not found.', 'NOT_FOUND');
    return doc;
  }

  private takeFailure(op: 'get' | 'batchUpdate') {
    const i = this.failures.findIndex((f) => f.op === op);
    return i >= 0 ? this.failures.splice(i, 1)[0] : undefined;
  }

  get(id: string): { status: number; body: unknown } {
    this.getCalls++;
    const f = this.takeFailure('get');
    if (f) return { status: f.status, body: f.body ?? errorBody(f.status, 'backend error') };
    try {
      const doc = this.access(id);
      const toTab = (t: FakeTab): docs_v1.Schema$Tab => ({
        tabProperties: { tabId: t.tabId, title: t.title },
        documentTab: { body: toApiBody(t.body) },
        ...(t.children.length && { childTabs: t.children.map(toTab) }),
      });
      return {
        status: 200,
        body: {
          documentId: doc.id,
          title: doc.title,
          revisionId: `rev-${doc.revision}`,
          tabs: doc.tabs.map(toTab),
        },
      };
    } catch (e) {
      return fail(e);
    }
  }

  batchUpdate(
    id: string,
    req: docs_v1.Schema$BatchUpdateDocumentRequest,
  ): { status: number; body: unknown } {
    this.batchCalls.push(req);
    const f = this.takeFailure('batchUpdate');
    if (f && !f.apply)
      return { status: f.status, body: f.body ?? errorBody(f.status, 'backend error') };
    try {
      const doc = this.access(id);
      this.hooks.beforeBatch?.(doc);
      const required = req.writeControl?.requiredRevisionId;
      if (required && required !== `rev-${doc.revision}`) {
        throw new FakeApiError(
          400,
          `The required revision ID ${required} does not match the latest revision.`,
        );
      }
      for (const r of req.requests ?? []) this.apply(doc, r);
      doc.revision++;
      if (f?.apply) return { status: f.status, body: errorBody(f.status, 'backend error') };
      return {
        status: 200,
        body: {
          documentId: id,
          replies: [],
          writeControl: { requiredRevisionId: `rev-${doc.revision}` },
        },
      };
    } catch (e) {
      return fail(e);
    }
  }

  private apply(doc: FakeDoc, r: docs_v1.Schema$Request): void {
    const tabFor = (tabId?: string | null) => this.tab(doc.id, tabId ?? undefined);
    if (r.insertText) {
      const loc = r.insertText.location!;
      insertText(tabFor(loc.tabId).body, loc.index!, r.insertText.text!);
    } else if (r.insertTable) {
      const loc = r.insertTable.location!;
      insertTable(tabFor(loc.tabId).body, loc.index!, r.insertTable.rows!, r.insertTable.columns!);
    } else if (r.updateParagraphStyle) {
      const { range, paragraphStyle } = r.updateParagraphStyle;
      forRange(
        tabFor(range!.tabId).body,
        range!.startIndex!,
        range!.endIndex!,
        (p) => (p.style = paragraphStyle!.namedStyleType!),
      );
    } else if (r.deleteParagraphBullets) {
      const { range } = r.deleteParagraphBullets;
      forRange(
        tabFor(range!.tabId).body,
        range!.startIndex!,
        range!.endIndex!,
        (p) => (p.bullet = false),
      );
    } else if (r.updateTextStyle) {
      const { range, textStyle } = r.updateTextStyle;
      forRange(tabFor(range!.tabId).body, range!.startIndex!, range!.endIndex!, (p, l) => {
        for (let i = 0; i < p.text.length; i++) {
          const abs = l.start + i;
          if (abs >= range!.startIndex! && abs < range!.endIndex!) p.bold[i] = !!textStyle!.bold;
        }
      });
    } else {
      throw new FakeApiError(400, `Unsupported request in fake: ${Object.keys(r).join(',')}`);
    }
  }
}

export function errorBody(status: number, message: string, apiStatus?: string, reason?: string) {
  return {
    error: {
      code: status,
      message,
      status:
        apiStatus ??
        (status === 503 ? 'UNAVAILABLE' : status === 429 ? 'RESOURCE_EXHAUSTED' : 'ERROR'),
      ...(reason && { errors: [{ reason, message }] }),
    },
  };
}

function fail(e: unknown): { status: number; body: unknown } {
  if (e instanceof FakeApiError)
    return { status: e.status, body: errorBody(e.status, e.message, e.apiStatus) };
  throw e;
}

export { elSize };
