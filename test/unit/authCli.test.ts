import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthCliError, runAuthCli, runAuthStatus } from '../../src/auth/authCli.js';
import { FileTokenStore } from '../../src/auth/tokenStore.js';
import { loadConfig, requiredScopes, SCOPES } from '../../src/config.js';
import { LogSink } from '../helpers/harness.js';

let dir: string;
let tokenPath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gdm-auth-'));
  tokenPath = path.join(dir, 'cfg', 'token.json');
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1/);
});
afterEach(() => {
  nock.cleanAll();
  rmSync(dir, { recursive: true, force: true });
});

const config = (env: Record<string, string> = {}) =>
  loadConfig({
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csecret',
    GOOGLE_TOKEN_PATH: tokenPath,
    ...env,
  });

const makeClient = (opts: { clientId: string; clientSecret: string; redirectUri: string }) => {
  const c = new OAuth2Client(opts);
  c.verifyIdToken = (async () => ({ getPayload: () => ({ email: 'owner@example.com' }) })) as never;
  return c;
};

/** Simulates the browser: follows the consent URL straight to our loopback callback. */
const browser =
  (mutate: (cb: URL) => void = () => undefined) =>
  async (authUrl: string) => {
    const u = new URL(authUrl);
    const cb = new URL(u.searchParams.get('redirect_uri')!);
    cb.searchParams.set('state', u.searchParams.get('state')!);
    cb.searchParams.set('code', 'auth-code');
    mutate(cb);
    await fetch(cb);
    // Unrelated path on the loopback server is a 404, not a crash.
    await fetch(new URL('/favicon.ico', cb));
  };

describe('runAuthCli', () => {
  it('runs the loopback PKCE flow and stores a 0600 token with the account email', async () => {
    let tokenBody = '';
    nock('https://oauth2.googleapis.com')
      .post('/token', (b) => ((tokenBody = new URLSearchParams(b).toString()), true))
      .reply(200, {
        access_token: 'at',
        refresh_token: 'rt',
        scope: requiredScopes({ enableDrafts: false }).join(' '),
        id_token: 'idt',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    const out = new LogSink();
    let seenUrl = '';
    await runAuthCli({
      config: config(),
      out,
      makeClient,
      openBrowser: async (u) => ((seenUrl = u), browser()(u)),
    });
    const url = new URL(seenUrl);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(
      requiredScopes({ enableDrafts: false }),
    );
    expect(url.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/,
    );
    expect(new URLSearchParams(tokenBody).get('code_verifier')).toBeTruthy();
    const stored = JSON.parse(readFileSync(tokenPath, 'utf8'));
    expect(stored).toMatchObject({
      type: 'authorized_user',
      client_id: 'cid',
      refresh_token: 'rt',
      account_email: 'owner@example.com',
    });
    expect(stored.access_token).toBeUndefined();
    if (process.platform !== 'win32') expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(out.lines.join('')).toMatch(/Authenticated as owner@example.com/);
  });

  it('requests gmail.compose when drafts are enabled', async () => {
    nock('https://oauth2.googleapis.com')
      .post('/token')
      .reply(200, { refresh_token: 'rt', scope: requiredScopes({ enableDrafts: true }).join(' ') });
    let seen = '';
    await runAuthCli({
      config: config({ ENABLE_DRAFTS: 'true' }),
      out: new LogSink(),
      makeClient,
      openBrowser: async (u) => ((seen = u), browser()(u)),
    });
    expect(new URL(seen).searchParams.get('scope')).toContain(SCOPES.gmailCompose);
  });

  it('fails when scopes were unticked on the consent screen', async () => {
    nock('https://oauth2.googleapis.com')
      .post('/token')
      .reply(200, { refresh_token: 'rt', scope: SCOPES.documents });
    await expect(
      runAuthCli({ config: config(), out: new LogSink(), makeClient, openBrowser: browser() }),
    ).rejects.toThrow(/not granted: .*gmail.send/);
  });

  it('fails without a refresh token', async () => {
    nock('https://oauth2.googleapis.com')
      .post('/token')
      .reply(200, { access_token: 'at', scope: requiredScopes({ enableDrafts: false }).join(' ') });
    await expect(
      runAuthCli({ config: config(), out: new LogSink(), makeClient, openBrowser: browser() }),
    ).rejects.toThrow(/did not return a refresh token/);
  });

  it('rejects a state mismatch', async () => {
    await expect(
      runAuthCli({
        config: config(),
        out: new LogSink(),
        makeClient,
        openBrowser: browser((cb) => cb.searchParams.set('state', 'forged')),
      }),
    ).rejects.toThrow(/state mismatch/);
  });

  it('surfaces consent errors and missing codes', async () => {
    await expect(
      runAuthCli({
        config: config(),
        out: new LogSink(),
        makeClient,
        openBrowser: browser(
          (cb) => (cb.searchParams.delete('code'), cb.searchParams.set('error', 'access_denied')),
        ),
      }),
    ).rejects.toThrow(/access_denied/);
    await expect(
      runAuthCli({
        config: config(),
        out: new LogSink(),
        makeClient,
        openBrowser: browser((cb) => cb.searchParams.delete('code')),
      }),
    ).rejects.toThrow(/did not return an authorization code/);
  });

  it('times out and tells the user when no browser opens', async () => {
    const out = new LogSink();
    await expect(
      runAuthCli({
        config: config(),
        out,
        makeClient,
        timeoutMs: 50,
        openBrowser: async () => Promise.reject(new Error('no browser')),
      }),
    ).rejects.toThrow(/Timed out/);
    expect(out.lines.join('')).toMatch(/copy the URL above/);
  });

  it('explains Google Cloud setup when the client is not configured', async () => {
    await expect(
      runAuthCli({ config: loadConfig({ GOOGLE_TOKEN_PATH: tokenPath }), out: new LogSink() }),
    ).rejects.toBeInstanceOf(AuthCliError);
  });
});

describe('runAuthStatus', () => {
  it('reports a missing token', async () => {
    const out = new LogSink();
    expect(await runAuthStatus({ config: config(), out })).toBe(false);
    expect(out.lines.join('')).toMatch(/No Google token found/);
  });

  it('reports account, scopes, missing scopes and refresh health', async () => {
    await new FileTokenStore(tokenPath).write({
      type: 'authorized_user',
      client_id: 'cid',
      client_secret: 'cs',
      refresh_token: 'rt',
      scope: requiredScopes({ enableDrafts: false }).join(' '),
      account_email: 'me@example.com',
    });
    nock('https://oauth2.googleapis.com')
      .post('/token')
      .reply(200, { access_token: 'x', expires_in: 3600 });
    const out = new LogSink();
    expect(await runAuthStatus({ config: config(), out })).toBe(true);
    expect(out.lines.join('')).toMatch(/me@example.com[\s\S]*Refresh:\s+OK/);

    nock('https://oauth2.googleapis.com').post('/token').reply(400, { error: 'invalid_grant' });
    const out2 = new LogSink();
    expect(await runAuthStatus({ config: config({ ENABLE_DRAFTS: 'true' }), out: out2 })).toBe(
      false,
    );
    expect(out2.lines.join('')).toMatch(/Missing:.*gmail.compose[\s\S]*FAILED \(invalid_grant\)/);
  });
});
