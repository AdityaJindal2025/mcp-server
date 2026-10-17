/**
 * Checklist for PS §9: every guardrail is configurable and enforced through
 * the real MCP surface.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { para } from '../helpers/fakeDocs.js';
import { makeHarness, textOf, type Harness } from '../helpers/harness.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg';
let h: Harness;
afterEach(async () => h?.close());

describe('PS §9 guardrails', () => {
  it('EMAIL_ALLOWED_DOMAINS, EMAIL_MAX_RECIPIENTS, EMAIL_MAX_PER_HOUR, DOCS_MAX_APPEND_CHARS, DOCS_ALLOWED_IDS', async () => {
    h = await makeHarness({
      env: {
        EMAIL_ALLOWED_DOMAINS: 'example.com',
        EMAIL_MAX_RECIPIENTS: '2',
        EMAIL_MAX_PER_HOUR: '1',
        DOCS_MAX_APPEND_CHARS: '5',
        DOCS_ALLOWED_IDS: ID,
      },
    });
    h.docs.add(ID, 'D', [{ body: [para('a')] }]);
    const other = '2ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210zyxwvu';
    h.docs.add(other, 'Other', [{ body: [para('a')] }]);

    expect(
      textOf(await h.call('gmail_send_email', { to: ['x@evil.com'], subject: 's', body: 'b' })),
    ).toMatch(/Blocked recipient/);
    expect(
      textOf(
        await h.call('gmail_send_email', {
          to: ['a@example.com', 'b@example.com', 'c@example.com'],
          subject: 's',
          body: 'b',
        }),
      ),
    ).toMatch(/Too many recipients/);
    expect(
      (await h.call('gmail_send_email', { to: ['a@example.com'], subject: 's', body: 'b' }))
        .isError,
    ).toBeFalsy();
    expect(
      textOf(await h.call('gmail_send_email', { to: ['a@example.com'], subject: 's', body: 'b' })),
    ).toMatch(/Hourly send limit/);
    expect(textOf(await h.call('gdocs_append_text', { document: ID, text: '123456' }))).toMatch(
      /limit is 5/,
    );
    expect(textOf(await h.call('gdocs_append_text', { document: other, text: 'x' }))).toMatch(
      /not allowed to access document/,
    );
    expect(textOf(await h.call('gdocs_append_table', { document: other, rows: [['x']] }))).toMatch(
      /not allowed to access document/,
    );
    expect(h.gmail.sent).toHaveLength(1);
  });

  it('EMAIL_DRY_RUN is a global switch', async () => {
    h = await makeHarness({ env: { EMAIL_DRY_RUN: 'true' } });
    await h.call('gmail_send_email', {
      to: ['a@example.com'],
      subject: 's',
      body: 'b',
      dry_run: false,
    });
    expect(h.gmail.calls).toBe(0);
  });

  it('append-only: no tool can delete or replace document content', async () => {
    h = await makeHarness({ env: { ENABLE_DRAFTS: 'true' } });
    const { tools } = await h.client.listTools();
    expect(
      tools.map((t) => t.name).filter((n) => /delete|replace|update|edit|remove/.test(n)),
    ).toEqual([]);
    h.docs.add(ID, 'D', [{ body: [para('keep me')] }]);
    await h.call('gdocs_append_text', { document: ID, text: 'x' });
    await h.call('gdocs_append_table', { document: ID, rows: [['y']] });
    const kinds = h.docs.batchCalls.flatMap((c) =>
      (c.requests ?? []).map((r) => Object.keys(r)[0]),
    );
    expect(new Set(kinds)).toEqual(
      new Set([
        'insertText',
        'updateParagraphStyle',
        'deleteParagraphBullets',
        'insertTable',
        'updateTextStyle',
      ]),
    );
    expect(kinds).not.toContain('deleteContentRange');
    expect(kinds).not.toContain('replaceAllText');
  });

  it('audit log: one line per write with ids, never bodies/text/tokens', async () => {
    h = await makeHarness();
    h.docs.add(ID, 'D', [{ body: [para('a')] }]);
    await h.call('gmail_send_email', {
      to: ['a@example.com'],
      subject: 'Top secret subject',
      body: 'TOP SECRET BODY',
    });
    await h.call('gdocs_append_text', { document: ID, text: 'TOP SECRET TEXT' });
    expect(h.audit.events.map((e) => e.tool)).toEqual(['gmail_send_email', 'gdocs_append_text']);
    expect(h.audit.events[0]).toMatchObject({ message_id: 'msg-1', transport: 'stdio' });
    expect(h.audit.events[1]).toMatchObject({ revision_id: 'rev-2', doc_id: ID });
    const everything = JSON.stringify(h.audit.events) + h.logs.lines.join('');
    for (const secret of [
      'TOP SECRET',
      'Top secret subject',
      'test-access-token',
      'refresh-token',
      'csecret',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});
