import { afterEach, expect, it } from 'vitest';
import { SCOPES } from '../../src/config.js';
import { makeHarness, textOf, type Harness } from '../helpers/harness.js';

let h: Harness;
afterEach(async () => h?.close());

it('is not registered unless ENABLE_DRAFTS=true', async () => {
  h = await makeHarness();
  const { tools } = await h.client.listTools();
  expect(tools.map((t) => t.name)).not.toContain('gmail_create_draft');
});

it('creates a draft without sending and without counting against the hourly limit', async () => {
  h = await makeHarness({ env: { ENABLE_DRAFTS: 'true', EMAIL_MAX_PER_HOUR: '1' } });
  for (let i = 0; i < 2; i++) {
    const r = await h.call('gmail_create_draft', {
      to: ['a@example.com'],
      subject: `S${i}`,
      body: 'B',
    });
    expect(r.isError).toBeFalsy();
  }
  expect(h.gmail.drafts).toHaveLength(2);
  expect(h.gmail.sent).toHaveLength(0);
  const r = await h.call('gmail_create_draft', { to: ['a@example.com'], subject: 'S', body: 'B' });
  expect(r.structuredContent).toEqual({ draft_id: 'draft-3', message_id: 'dmsg-3' });
  expect(textOf(r)).toMatch(/NOT been sent/);
  expect(h.audit.events.at(-1)).toMatchObject({
    tool: 'gmail_create_draft',
    status: 'ok',
    draft_id: 'draft-3',
  });
});

it('still enforces the recipient allowlist', async () => {
  h = await makeHarness({ env: { ENABLE_DRAFTS: 'true', EMAIL_ALLOWED_DOMAINS: 'example.com' } });
  const r = await h.call('gmail_create_draft', { to: ['a@evil.com'], subject: 'S', body: 'B' });
  expect(textOf(r)).toMatch(/Blocked recipient\(s\): a@evil.com/);
});

it('asks to re-run auth when gmail.compose was not granted (token from before drafts were enabled)', async () => {
  h = await makeHarness({
    env: { ENABLE_DRAFTS: 'true' },
    scopes: [SCOPES.gmailSend, SCOPES.documents],
  });
  const r = await h.call('gmail_create_draft', { to: ['a@example.com'], subject: 'S', body: 'B' });
  expect(textOf(r)).toMatch(/gmail.compose. Run `npx gmail-docs-mcp auth` again/);
});

it('maps Google errors', async () => {
  h = await makeHarness({ env: { ENABLE_DRAFTS: 'true' } });
  h.gmail.failures.push({ op: 'draft', status: 500 });
  const r = await h.call('gmail_create_draft', { to: ['a@example.com'], subject: 'S', body: 'B' });
  expect(r.isError).toBe(true);
  expect(h.audit.events.at(-1)).toMatchObject({
    status: 'error',
    error_code: 'GOOGLE_UNAVAILABLE',
  });
});
