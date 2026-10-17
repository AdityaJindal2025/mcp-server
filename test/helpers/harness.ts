import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { OAuth2Client } from 'google-auth-library';
import nock from 'nock';
import { createGoogleClient } from '../../src/auth/googleClient.js';
import { FileTokenStore } from '../../src/auth/tokenStore.js';
import { loadConfig, requiredScopes, SCOPES, type Config } from '../../src/config.js';
import { MemoryAudit } from '../../src/lib/audit.js';
import { Logger } from '../../src/lib/logger.js';
import type { Deps } from '../../src/lib/tool.js';
import { createDeps, createServerFactory } from '../../src/server.js';
import { errorBody, FakeDocsStore } from './fakeDocs.js';

export const ACCOUNT = 'owner@example.com';
export const ALL_SCOPES = requiredScopes({ enableDrafts: true });

export interface SentMessage {
  raw: string;
  mime: string;
}

export class FakeGmail {
  sent: SentMessage[] = [];
  drafts: SentMessage[] = [];
  failures: { op: 'send' | 'draft'; status: number; body?: unknown }[] = [];
  calls = 0;

  take(op: 'send' | 'draft') {
    const i = this.failures.findIndex((f) => f.op === op);
    return i >= 0 ? this.failures.splice(i, 1)[0] : undefined;
  }
}

export class LogSink {
  lines: string[] = [];
  write(chunk: string) {
    this.lines.push(chunk);
    return true;
  }
}

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') return JSON.parse(body) as Record<string, unknown>;
  return (body ?? {}) as Record<string, unknown>;
}

/** Installs nock interceptors backed by the fakes. */
export function installGoogleMocks(docs: FakeDocsStore, gmail: FakeGmail): void {
  nock('https://docs.googleapis.com')
    .persist()
    .get(/^\/v1\/documents\/[^/:%]+(\?.*)?$/)
    .reply((uri) => {
      const id = decodeURIComponent(uri.split('?')[0]!.split('/').pop()!);
      const r = docs.get(id);
      return [r.status, r.body as nock.Body];
    })
    .post(/^\/v1\/documents\/[^/]+(:|%3A)batchUpdate/)
    .reply((uri, body) => {
      const id = decodeURIComponent(uri.split('/').pop()!.split(/:|%3A/)[0]!);
      const r = docs.batchUpdate(id, parseBody(body));
      return [r.status, r.body as nock.Body];
    });

  nock('https://gmail.googleapis.com')
    .persist()
    .post('/gmail/v1/users/me/messages/send')
    .reply((_uri, body) => {
      gmail.calls++;
      const f = gmail.take('send');
      if (f) return [f.status, (f.body ?? errorBody(f.status, 'backend error')) as nock.Body];
      const raw = String(parseBody(body)['raw']);
      gmail.sent.push({ raw, mime: Buffer.from(raw, 'base64url').toString('utf8') });
      const n = gmail.sent.length;
      return [200, { id: `msg-${n}`, threadId: `thread-${n}`, labelIds: ['SENT'] }];
    })
    .post('/gmail/v1/users/me/drafts')
    .reply((_uri, body) => {
      const f = gmail.take('draft');
      if (f) return [f.status, (f.body ?? errorBody(f.status, 'backend error')) as nock.Body];
      const raw = String((parseBody(body)['message'] as Record<string, unknown>)['raw']);
      gmail.drafts.push({ raw, mime: Buffer.from(raw, 'base64url').toString('utf8') });
      const n = gmail.drafts.length;
      return [200, { id: `draft-${n}`, message: { id: `dmsg-${n}`, threadId: `dthread-${n}` } }];
    });
}

export interface HarnessOptions {
  env?: Record<string, string>;
  scopes?: string[];
  /** Don't write a token file (simulates "never ran auth"). */
  noToken?: boolean;
  /** Seed an expired access token so the client must refresh (to test invalid_grant). */
  expiredAccessToken?: boolean;
  protocol?: 'legacy' | 'modern';
}

export interface Harness {
  client: Client;
  config: Config;
  deps: Deps;
  docs: FakeDocsStore;
  gmail: FakeGmail;
  audit: MemoryAudit;
  logs: LogSink;
  tokenPath: string;
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gdm-test-'));
  const tokenPath = path.join(dir, 'token.json');
  const store = new FileTokenStore(tokenPath);
  if (!opts.noToken) {
    await store.write({
      type: 'authorized_user',
      client_id: 'cid.apps.googleusercontent.com',
      client_secret: 'csecret',
      refresh_token: 'refresh-token',
      scope: (opts.scopes ?? ALL_SCOPES).join(' '),
      account_email: ACCOUNT,
    });
  }
  const config = loadConfig({ GOOGLE_TOKEN_PATH: tokenPath, ...opts.env });
  const logs = new LogSink();
  const logger = new Logger('debug', logs);
  const audit = new MemoryAudit();
  const google = createGoogleClient({
    store,
    config,
    makeAuth: (token) => {
      const auth = new OAuth2Client({
        clientId: token.client_id,
        clientSecret: token.client_secret,
      });
      auth.setCredentials({
        refresh_token: token.refresh_token,
        access_token: 'test-access-token',
        expiry_date: opts.expiredAccessToken ? Date.now() - 1000 : Date.now() + 3_600_000,
      });
      return auth;
    },
  });
  const deps = createDeps(config, { google, audit, logger });

  const docs = new FakeDocsStore();
  const gmail = new FakeGmail();
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  installGoogleMocks(docs, gmail);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(createServerFactory(deps, 'stdio'), { transport: serverTransport });
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { versionNegotiation: { mode: opts.protocol === 'modern' ? { pin: '2026-07-28' } : 'legacy' } },
  );
  await client.connect(clientTransport);

  return {
    client,
    config,
    deps,
    docs,
    gmail,
    audit,
    logs,
    tokenPath,
    call: (name, args) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    async close() {
      await client.close();
      await handle.close();
      nock.cleanAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

export { SCOPES };
