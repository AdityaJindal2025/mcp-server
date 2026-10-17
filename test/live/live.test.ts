/**
 * Live smoke tests against real Google APIs (PS §14.5, T1.24). Opt-in:
 *   LIVE_TESTS=1 GOOGLE_TOKEN_PATH=... LIVE_SCRATCH_DOC_ID=... [LIVE_EMAIL_TO=...] npm run test:live
 * Sends real email (to yourself by default) and appends to a scratch doc.
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileTokenStore } from '../../src/auth/tokenStore.js';
import { loadConfig } from '../../src/config.js';
import { MemoryAudit } from '../../src/lib/audit.js';
import { createDeps, createServerFactory } from '../../src/server.js';

const docId = process.env.LIVE_SCRATCH_DOC_ID;
const enabled = process.env.LIVE_TESTS === '1' && !!process.env.GOOGLE_TOKEN_PATH && !!docId;

describe.skipIf(!enabled)('live Google smoke', () => {
  let client: Client;
  let close: () => Promise<void>;
  let to: string;
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

  beforeAll(async () => {
    const config = loadConfig({ ...process.env, ENABLE_DRAFTS: 'false', EMAIL_DRY_RUN: 'false' });
    const token = await new FileTokenStore(config.google.tokenPath).read();
    to = process.env.LIVE_EMAIL_TO ?? token.account_email ?? '';
    const deps = createDeps(config, { audit: new MemoryAudit() });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServerFactory(deps, 'stdio'), { transport: st });
    client = new Client({ name: 'live', version: '1' });
    await client.connect(ct);
    close = async () => {
      await client.close();
      await handle.close();
    };
  });
  afterAll(async () => close?.());

  const stamp = new Date().toISOString();

  it('sends plain-text and HTML emails with a unicode subject', async () => {
    for (const body_format of ['text', 'html'] as const) {
      const r = await call('gmail_send_email', {
        to: [to],
        subject: `gmail-docs-mcp live ${body_format} 🚀 週報 ${stamp}`,
        body: body_format === 'html' ? '<p>Live <b>HTML</b> test</p>' : 'Live text test',
        body_format,
      });
      expect(r.isError, text(r)).toBeFalsy();
    }
  });

  it('appends text twice and leaves existing content byte-for-byte unchanged', async () => {
    const before = await call('gdocs_get_document_info', { document: docId!, tail_chars: 5000 });
    expect(before.isError, text(before)).toBeFalsy();
    const prefix = (before.structuredContent as { tail_text: string }).tail_text;
    const a = await call('gdocs_append_text', { document: docId!, text: `Live append ${stamp}` });
    expect(a.isError, text(a)).toBeFalsy();
    const b = await call('gdocs_append_text', {
      document: docId!,
      text: `Second line ${stamp}`,
      paragraph_style: 'HEADING_3',
    });
    expect(b.isError, text(b)).toBeFalsy();
    const after = await call('gdocs_get_document_info', { document: docId!, tail_chars: 5000 });
    const tail = (after.structuredContent as { tail_text: string }).tail_text;
    expect(tail.endsWith(`Live append ${stamp}\nSecond line ${stamp}\n`)).toBe(true);
    if (prefix.length < 5000 - 100) expect(tail.startsWith(prefix.replace(/\n$/, ''))).toBe(true);
  });

  it('appends a table', async () => {
    const r = await call('gdocs_append_table', {
      document: docId!,
      rows: [
        ['Test', 'Result'],
        ['login', 'pass'],
        ['checkout', `fail ${stamp}`],
      ],
    });
    expect(r.isError, text(r)).toBeFalsy();
  });
});
