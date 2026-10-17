import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { SCOPES } from '../../src/config.js';
import { errorBody } from '../helpers/fakeDocs.js';
import { makeHarness, textOf, type Harness, type HarnessOptions } from '../helpers/harness.js';

let h: Harness;
afterEach(async () => h?.close());
const setup = async (opts: HarnessOptions = {}) => (h = await makeHarness(opts));

const decodeSubject = (mime: string) => {
  const m = /^Subject: (.*(?:\r\n .*)*)/m.exec(mime)![1]!;
  const words = [...m.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
  return words.length
    ? Buffer.concat(words.map((w) => Buffer.from(w[1]!, 'base64'))).toString('utf8')
    : m;
};

describe('gmail_send_email', () => {
  it('sends a plain-text email and returns text + structuredContent', async () => {
    await setup();
    const r = await h.call('gmail_send_email', {
      to: ['alex@example.com', 'ALEX@example.com'],
      cc: ['sam@example.com'],
      bcc: ['boss@example.com'],
      subject: 'Weekly update',
      body: 'Hello team',
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(
      'Email sent to alex@example.com, sam@example.com (+1 bcc) (subject: "Weekly update"). Gmail message id: msg-1',
    );
    expect(r.structuredContent).toEqual({
      status: 'sent',
      message_id: 'msg-1',
      thread_id: 'thread-1',
      to: ['alex@example.com'],
      cc: ['sam@example.com'],
      bcc_count: 1,
      subject: 'Weekly update',
    });
    const mime = h.gmail.sent[0]!.mime;
    expect(mime).toMatch(/^To: alex@example.com\r$/m);
    expect(mime).toMatch(/^Bcc: boss@example.com\r$/m);
    expect(mime).not.toMatch(/^From:/m);
    expect(h.audit.events).toEqual([
      expect.objectContaining({
        tool: 'gmail_send_email',
        status: 'ok',
        to: ['alex@example.com'],
        bcc_count: 1,
        message_id: 'msg-1',
        body_len: 10,
      }),
    ]);
    expect(JSON.stringify(h.audit.events)).not.toContain('Hello team');
    expect(JSON.stringify(h.audit.events)).not.toContain('Weekly update');
  });

  it('sends html as multipart/alternative with an emoji/CJK subject', async () => {
    await setup({ env: { GMAIL_SEND_AS: 'Alias@Example.com' } });
    const subject = '週報 🚀 update';
    const r = await h.call('gmail_send_email', {
      to: ['a@example.com'],
      subject,
      body: '<p>Hi <b>there</b></p>',
      body_format: 'html',
    });
    expect(r.isError).toBeFalsy();
    const mime = h.gmail.sent[0]!.mime;
    expect(mime).toMatch(/Content-Type: multipart\/alternative/);
    expect(mime).toMatch(/^From: Alias@example.com\r$/m);
    expect(decodeSubject(mime)).toBe(subject);
  });

  it('dry_run returns the composed email and sends nothing', async () => {
    await setup();
    const r = await h.call('gmail_send_email', {
      to: ['a@example.com'],
      subject: 'S',
      body: 'Body text',
      dry_run: true,
    });
    expect(h.gmail.calls).toBe(0);
    expect(r.structuredContent).toMatchObject({ status: 'dry_run', message_id: '', thread_id: '' });
    expect(textOf(r)).toMatch(/^Dry run: email to a@example.com \(subject: "S"\) was NOT sent\./);
    expect(textOf(r)).toContain('Body text');
    expect(h.audit.events[0]).toMatchObject({ status: 'dry_run' });
  });

  it('EMAIL_DRY_RUN forces dry runs and says so', async () => {
    await setup({ env: { EMAIL_DRY_RUN: 'true' } });
    const r = await h.call('gmail_send_email', { to: ['a@example.com'], subject: 'S', body: 'B' });
    expect(h.gmail.calls).toBe(0);
    expect(r.structuredContent).toMatchObject({ status: 'dry_run' });
    expect(textOf(r)).toContain('EMAIL_DRY_RUN');
  });

  it('blocks recipients outside the allowlist, naming them; nothing sent', async () => {
    await setup({ env: { EMAIL_ALLOWED_DOMAINS: 'example.com' } });
    const r = await h.call('gmail_send_email', {
      to: ['ok@example.com', 'x@evil.com'],
      cc: ['y@other.org'],
      subject: 'S',
      body: 'B',
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      'Blocked recipient(s): x@evil.com, y@other.org. This server only sends to: example.com. Nothing was sent.',
    );
    expect(h.gmail.calls).toBe(0);
  });

  it('rejects CRLF in the subject (header injection)', async () => {
    await setup();
    const r = await h.call('gmail_send_email', {
      to: ['a@example.com'],
      subject: 'Hi\r\nBcc: evil@evil.com',
      body: 'B',
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/single line/);
    expect(h.gmail.calls).toBe(0);
  });

  it('rejects CRLF in addresses', async () => {
    await setup();
    const r = await h.call('gmail_send_email', {
      to: ['a@example.com\r\nBcc: e@evil.com'],
      subject: 'S',
      body: 'B',
    });
    expect(r.isError).toBe(true);
    expect(h.gmail.calls).toBe(0);
  });

  it('rejects an empty to list via schema validation', async () => {
    await setup();
    const r = await h.call('gmail_send_email', { to: [], subject: 'S', body: 'B' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/to/);
  });

  it('enforces max recipients', async () => {
    await setup({ env: { EMAIL_MAX_RECIPIENTS: '2' } });
    const r = await h.call('gmail_send_email', {
      to: ['a@x.com', 'b@x.com', 'c@x.com'],
      subject: 'S',
      body: 'B',
    });
    expect(textOf(r)).toBe('Too many recipients (3). The limit is 2. Nothing was sent.');
  });

  it('enforces EMAIL_MAX_PER_HOUR on successful sends only', async () => {
    await setup({ env: { EMAIL_MAX_PER_HOUR: '1' } });
    await h.call('gmail_send_email', { to: ['a@x.com'], subject: 'S', body: 'B', dry_run: true });
    expect(
      (await h.call('gmail_send_email', { to: ['a@x.com'], subject: 'S', body: 'B' })).isError,
    ).toBeFalsy();
    const r = await h.call('gmail_send_email', { to: ['a@x.com'], subject: 'S', body: 'B' });
    expect(textOf(r)).toMatch(/Hourly send limit \(1\) reached/);
    expect(h.gmail.sent).toHaveLength(1);
  });

  it('returns the re-auth command when the token is missing', async () => {
    await setup({ noToken: true });
    const r = await h.call('gmail_send_email', { to: ['a@x.com'], subject: 'S', body: 'B' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('npx gmail-docs-mcp auth');
  });

  it('returns the re-auth command on invalid_grant', async () => {
    await setup({ expiredAccessToken: true });
    nock('https://oauth2.googleapis.com').post('/token').reply(400, {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    });
    const r = await h.call('gmail_send_email', { to: ['a@x.com'], subject: 'S', body: 'B' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/expired or was revoked\. Run `npx gmail-docs-mcp auth`/);
    expect(h.gmail.sent).toHaveLength(0);
  });

  it('refreshes an expired access token transparently', async () => {
    await setup({ expiredAccessToken: true });
    nock('https://oauth2.googleapis.com')
      .post('/token')
      .reply(200, { access_token: 'new', expires_in: 3600, token_type: 'Bearer' });
    const r = await h.call('gmail_send_email', { to: ['a@x.com'], subject: 'S', body: 'B' });
    expect(r.isError).toBeFalsy();
  });

  it('reports a missing gmail.send scope before calling Google', async () => {
    await setup({ scopes: [SCOPES.documents] });
    const r = await h.call('gmail_send_email', { to: ['a@x.com'], subject: 'S', body: 'B' });
    expect(textOf(r)).toMatch(
      /missing permission\(s\): https:\/\/www.googleapis.com\/auth\/gmail.send/,
    );
    expect(h.gmail.calls).toBe(0);
  });

  it('maps a 403 insufficient scope from Google', async () => {
    await setup();
    h.gmail.failures.push({
      op: 'send',
      status: 403,
      body: errorBody(
        403,
        'Request had insufficient authentication scopes.',
        'PERMISSION_DENIED',
        'insufficientPermissions',
      ),
    });
    const r = await h.call('gmail_send_email', { to: ['a@x.com'], subject: 'S', body: 'B' });
    expect(textOf(r)).toMatch(/missing a permission needed for Gmail/);
    expect(h.audit.events[0]).toMatchObject({ status: 'error', error_code: 'SCOPE_MISSING' });
  });

  it('retries a 429 and then succeeds', async () => {
    await setup();
    h.gmail.failures.push({ op: 'send', status: 429 });
    const r = await h.call('gmail_send_email', { to: ['a@x.com'], subject: 'S', body: 'B' });
    expect(r.isError).toBeFalsy();
    expect(h.gmail.calls).toBe(2);
  });

  it('does NOT retry a 5xx (D3) and warns the email may have been sent', async () => {
    await setup();
    h.gmail.failures.push({ op: 'send', status: 503 });
    const r = await h.call('gmail_send_email', { to: ['a@x.com'], subject: 'S', body: 'B' });
    expect(h.gmail.calls).toBe(1);
    expect(textOf(r)).toMatch(/may or may not have been sent/);
  });

  it('client_request_id returns the original result instead of re-sending', async () => {
    await setup();
    const args = { to: ['a@x.com'], subject: 'S', body: 'B', client_request_id: 'req-1' };
    const first = await h.call('gmail_send_email', args);
    const second = await h.call('gmail_send_email', args);
    expect(h.gmail.sent).toHaveLength(1);
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(textOf(second)).toMatch(/nothing was repeated/);
    const conflict = await h.call('gmail_send_email', { ...args, subject: 'Different' });
    expect(textOf(conflict)).toMatch(/already used with different arguments/);
  });
});
