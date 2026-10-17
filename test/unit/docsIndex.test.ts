import { describe, expect, it } from 'vitest';
import type { docs_v1 } from '@googleapis/docs';
import {
  bodyEnd,
  bodyText,
  flattenTabs,
  lastParagraphIsEmpty,
  lastTable,
  planAppend,
  selectTab,
  tailText,
} from '../../src/lib/docsIndex.js';
import { para, toApiBody } from '../helpers/fakeDocs.js';

const body = (...texts: string[]) => toApiBody(texts.map((t) => para(t)));

describe('bodyEnd / lastParagraphIsEmpty', () => {
  it('handles an empty doc', () => {
    const b = body('');
    expect(bodyEnd(b)).toBe(2);
    expect(lastParagraphIsEmpty(b)).toBe(true);
  });
  it('detects a non-empty last paragraph', () => {
    const b = body('Hello');
    expect(bodyEnd(b)).toBe(7);
    expect(lastParagraphIsEmpty(b)).toBe(false);
  });
  it('treats a body without content as ending at 1', () => {
    expect(bodyEnd({})).toBe(1);
    expect(lastParagraphIsEmpty({})).toBe(false);
  });
  it('treats a trailing table as non-empty', () => {
    const b = toApiBody([para('x'), { kind: 't', rows: [[[para('')]]] }]);
    expect(lastParagraphIsEmpty(b)).toBe(false);
    expect(lastTable(b)?.table?.rows).toBe(1);
  });
});

describe('planAppend', () => {
  it('prefixes a newline when the last line has text', () => {
    const p = planAppend(body('Hello'), 'World', true);
    expect(p).toMatchObject({
      insertIndex: 6,
      textToInsert: '\nWorld',
      insertedStart: 6,
      insertedEnd: 12,
      prefixed: true,
      newParagraphsStart: 7,
    });
  });
  it('does not prefix for an empty doc', () => {
    const p = planAppend(body(''), 'World', true);
    expect(p).toMatchObject({
      insertIndex: 1,
      textToInsert: 'World',
      prefixed: false,
      newParagraphsStart: 1,
      insertedEnd: 6,
    });
  });
  it('does not prefix after an empty last paragraph', () => {
    const p = planAppend(body('Hello', ''), 'World', true);
    expect(p.textToInsert).toBe('World');
    expect(p.insertIndex).toBe(7);
  });
  it('merges onto the last line when start_on_new_line is false', () => {
    const p = planAppend(body('Hello'), ' world', false);
    expect(p.textToInsert).toBe(' world');
    expect(p.newParagraphsStart).toBeUndefined();
  });
  it('only treats lines after the first break as new paragraphs when merging', () => {
    const p = planAppend(body('Hello'), ' a\nb', false);
    expect(p.newParagraphsStart).toBe(6 + 3);
  });
  it('normalizes CRLF', () => {
    expect(planAppend(body(''), 'a\r\nb\rc', true).textToInsert).toBe('a\nb\nc');
  });
  it('counts UTF-16 units for emoji', () => {
    const p = planAppend(body(''), '🚀', true);
    expect(p.insertedEnd - p.insertedStart).toBe(2);
  });
  it('drops an empty styling range', () => {
    const p = planAppend(body('Hello'), 'x\n', false);
    expect(p.newParagraphsStart).toBeUndefined();
  });
});

describe('tabs', () => {
  const doc: docs_v1.Schema$Document = {
    title: 'D',
    tabs: [
      {
        tabProperties: { tabId: 't.0', title: 'One' },
        documentTab: { body: body('a') },
        childTabs: [
          { tabProperties: { tabId: 't.child', title: 'Child' }, documentTab: { body: body('c') } },
        ],
      },
      { tabProperties: { tabId: 't.2', title: 'Two' }, documentTab: { body: body('b') } },
    ],
  };
  it('flattens tabs depth-first', () => {
    expect(flattenTabs(doc).map((t) => t.tabId)).toEqual(['t.0', 't.child', 't.2']);
  });
  it('selects first tab by default, or by id including child tabs', () => {
    expect(selectTab(doc).tabId).toBe('t.0');
    expect(bodyText(selectTab(doc, 't.child').body)).toBe('c\n');
  });
  it('lists available tabs when the id is unknown', () => {
    expect(() => selectTab(doc, 't.nope')).toThrow(
      /Available tabs: t\.0 \("One"\), t\.child \("Child"\), t\.2 \("Two"\)/,
    );
  });
  it('falls back to doc.body when there are no tabs', () => {
    const t = flattenTabs({ title: 'X', body: body('z') });
    expect(t).toHaveLength(1);
    expect(t[0]!.tabId).toBeUndefined();
  });
});

describe('tailText', () => {
  it('returns the last n characters', () => {
    expect(tailText(body('Hello world'), 6)).toBe('world\n');
    expect(tailText(body('Hi'), 100)).toBe('Hi\n');
    expect(tailText(body('Hi'), 0)).toBe('');
  });
  it('never splits a surrogate pair', () => {
    const t = tailText(body('a🚀b'), 3);
    expect(t).toBe('b\n');
  });
  it('includes table text', () => {
    const b = toApiBody([
      para('x'),
      {
        kind: 't',
        rows: [
          [[para('h1')], [para('h2')]],
          [[para('v1')], [para('v2')]],
        ],
      },
      para(''),
    ]);
    expect(bodyText(b)).toBe('x\nh1\th2\nv1\tv2\n\n');
  });
});
