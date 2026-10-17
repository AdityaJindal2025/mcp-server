/**
 * Railway-style deployment: the server gets its Google token only from
 * GOOGLE_TOKEN_JSON (no token file), using the default createDeps wiring and
 * a real refresh-token exchange (mocked at the HTTP level).
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import nock from 'nock';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { MemoryAudit } from '../../src/lib/audit.js';
import { Logger } from '../../src/lib/logger.js';
import { createDeps, createServerFactory } from '../../src/server.js';
import { FakeDocsStore, para } from '../helpers/fakeDocs.js';
import { ALL_SCOPES, FakeGmail, installGoogleMocks, LogSink } from '../helpers/harness.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg';
const tokenJson = JSON.stringify({
  type: 'authorized_user',
  client_id: 'env-client.apps.googleusercontent.com',
  client_secret: 'env-secret',
  refresh_token: '1//env-refresh-token',
  scope: ALL_SCOPES.join(' '),
  account_email: 'owner@example.com',
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  nock.cleanAll();
});

it('serves tools with only GOOGLE_TOKEN_JSON (base64) set and never logs it', async () => {
  const config = loadConfig({
    GOOGLE_TOKEN_JSON: Buffer.from(tokenJson).toString('base64'),
    GOOGLE_TOKEN_PATH: '/definitely/not/here/token.json',
  });
  const logs = new LogSink();
  const deps = createDeps(config, { audit: new MemoryAudit(), logger: new Logger('debug', logs) });

  const docs = new FakeDocsStore();
  docs.add(ID, 'Changelog', [{ body: [para('Existing')] }]);
  const gmail = new FakeGmail();
  nock.disableNetConnect();
  let refreshBody = '';
  nock('https://oauth2.googleapis.com')
    .post('/token', (b) => ((refreshBody = new URLSearchParams(b).toString()), true))
    .reply(200, { access_token: 'fresh', expires_in: 3600, token_type: 'Bearer' });
  installGoogleMocks(docs, gmail);

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(createServerFactory(deps, 'http'), { transport: st });
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  cleanup = async () => {
    await client.close();
    await handle.close();
  };

  const r = (await client.callTool({
    name: 'gdocs_append_text',
    arguments: { document: ID, text: 'From Railway' },
  })) as CallToolResult;
  expect(r.isError).toBeFalsy();
  expect(new URLSearchParams(refreshBody).get('refresh_token')).toBe('1//env-refresh-token');
  expect(new URLSearchParams(refreshBody).get('client_id')).toBe(
    'env-client.apps.googleusercontent.com',
  );

  const s = (await client.callTool({
    name: 'gmail_send_email',
    arguments: { to: ['a@example.com'], subject: 'S', body: 'B' },
  })) as CallToolResult;
  expect(s.isError).toBeFalsy();

  const logged = logs.lines.join('');
  for (const secret of ['env-secret', 'env-refresh-token', tokenJson.slice(0, 40)]) {
    expect(logged).not.toContain(secret);
  }
});

it('reports a malformed GOOGLE_TOKEN_JSON as an actionable tool error', async () => {
  const deps = createDeps(loadConfig({ GOOGLE_TOKEN_JSON: 'garbage' }), {
    audit: new MemoryAudit(),
    logger: new Logger('error', new LogSink()),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(createServerFactory(deps, 'http'), { transport: st });
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  cleanup = async () => {
    await client.close();
    await handle.close();
  };
  const r = (await client.callTool({
    name: 'gdocs_get_document_info',
    arguments: { document: ID },
  })) as CallToolResult;
  expect(r.isError).toBe(true);
  const text = (r.content[0] as { text: string }).text;
  expect(text).toMatch(/GOOGLE_TOKEN_JSON environment variable is not valid JSON/);
  expect(text).not.toContain('garbage');
});
