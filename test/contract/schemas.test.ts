import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintTools, type LintableTool } from '../../src/lib/schemaLint.js';
import { makeHarness, type Harness } from '../helpers/harness.js';

/** Stable, key-sorted JSON so snapshots don't churn on key order. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

for (const drafts of [false, true]) {
  describe(`tools/list contract (ENABLE_DRAFTS=${drafts})`, () => {
    let h: Harness;
    let tools: LintableTool[];
    beforeAll(async () => {
      h = await makeHarness({ env: { ENABLE_DRAFTS: String(drafts) } });
      tools = (await h.client.listTools()).tools as LintableTool[];
    });
    afterAll(async () => h.close());

    it('exposes exactly the expected tools', () => {
      const expected = [
        'gmail_send_email',
        'gdocs_get_document_info',
        'gdocs_append_text',
        'gdocs_append_table',
      ];
      if (drafts) expected.push('gmail_create_draft');
      expect(tools.map((t) => t.name).sort()).toEqual(expected.sort());
    });

    it('passes the portability linter (C4, C5, C8)', () => {
      expect(lintTools(tools)).toEqual([]);
    });

    it('declares annotations: write tools are not read-only', () => {
      for (const t of tools as (LintableTool & { annotations?: Record<string, unknown> })[]) {
        expect(t.annotations?.['readOnlyHint']).toBe(t.name === 'gdocs_get_document_info');
        expect(t.annotations?.['openWorldHint']).toBe(true);
        expect(t.annotations?.['destructiveHint']).toBe(false);
        expect(t.outputSchema).toBeDefined();
      }
    });

    it('matches the committed schema snapshot (contract changes must be deliberate)', () => {
      expect(sortKeys(tools)).toMatchSnapshot();
    });
  });
}
