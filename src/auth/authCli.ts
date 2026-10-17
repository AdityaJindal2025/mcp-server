import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { requiredScopes, type Config } from '../config.js';
import { googleErrorInfo } from '../lib/errors.js';
import type { Writer } from '../lib/logger.js';
import {
  FileTokenStore,
  TOKEN_JSON_ENV,
  TokenFileError,
  tokenStoreFor,
  type TokenStore,
} from './tokenStore.js';

const CALLBACK_PATH = '/oauth2callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class AuthCliError extends Error {}

export interface AuthCliOptions {
  config: Config;
  out?: Writer;
  store?: TokenStore;
  /** Opens the consent URL; defaults to the `open` package. */
  openBrowser?: (url: string) => Promise<unknown>;
  timeoutMs?: number;
  /** Factory for tests. */
  makeClient?: (opts: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }) => OAuth2Client;
}

const SETUP_HELP = `Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.

Create a Desktop app OAuth client first:
  1. Google Cloud console -> APIs & Services -> enable "Gmail API" and "Google Docs API".
  2. OAuth consent screen -> Internal (Workspace) or External.
  3. Credentials -> Create credentials -> OAuth client ID -> Desktop app.
  4. Put the client ID and secret in .env (see .env.example), then run this command again.
See README.md, section "Google Cloud setup".`;

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>gmail-docs-mcp</title>
<body style="font-family:system-ui;margin:3rem"><h1>Signed in</h1><p>You can close this tab and return to the terminal.</p></body>`;

function parseScopes(scope: string | null | undefined): string[] {
  return (scope ?? '').split(/\s+/).filter(Boolean);
}

/** One-time interactive sign-in (installed-app loopback flow with PKCE). Never run by tools (C11). */
export async function runAuthCli(opts: AuthCliOptions): Promise<void> {
  const { config } = opts;
  const out = opts.out ?? process.stderr;
  const say = (line: string) => out.write(`${line}\n`);
  const clientId = config.google.clientId;
  const clientSecret = config.google.clientSecret;
  if (!clientId || !clientSecret) throw new AuthCliError(SETUP_HELP);
  const store = opts.store ?? new FileTokenStore(config.google.tokenPath);
  const scopes = requiredScopes(config);
  const state = randomBytes(16).toString('hex');

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const client =
    opts.makeClient?.({ clientId, clientSecret, redirectUri }) ??
    new OAuth2Client({ clientId, clientSecret, redirectUri });

  try {
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state,
      ...(codeChallenge && { code_challenge: codeChallenge }),
      code_challenge_method: CodeChallengeMethod.S256,
    });

    const codePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new AuthCliError(
              'Timed out waiting for the Google sign-in (5 minutes). Run the command again.',
            ),
          ),
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end();
          return;
        }
        const finish = (status: number, body: string, err?: Error) => {
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body);
          clearTimeout(timer);
          if (err) reject(err);
        };
        if (url.searchParams.get('state') !== state) {
          finish(
            400,
            'State mismatch. Close this tab and run the command again.',
            new AuthCliError('OAuth state mismatch; possible CSRF. Run the command again.'),
          );
          return;
        }
        const error = url.searchParams.get('error');
        if (error) {
          finish(
            400,
            `Sign-in failed: ${error}. You can close this tab.`,
            new AuthCliError(`Google sign-in failed: ${error}.`),
          );
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          finish(
            400,
            'Missing authorization code.',
            new AuthCliError('Google did not return an authorization code.'),
          );
          return;
        }
        finish(200, DONE_PAGE);
        resolve(code);
      });
    });

    // The callback can fail before we start awaiting; keep that from becoming an unhandled rejection.
    codePromise.catch(() => undefined);

    say('Open this URL in a browser to sign in to Google:\n');
    say(`  ${authUrl}\n`);
    say('Waiting for the sign-in to complete...');
    await (opts.openBrowser ?? (async (u: string) => (await import('open')).default(u)))(
      authUrl,
    ).catch(() => {
      say('(Could not open a browser automatically; copy the URL above.)');
    });

    const code = await codePromise;
    const { tokens } = await client.getToken({ code, ...(codeVerifier && { codeVerifier }) });
    if (!tokens.refresh_token) {
      throw new AuthCliError(
        'Google did not return a refresh token. Remove this app from https://myaccount.google.com/permissions and run the command again.',
      );
    }
    const granted = parseScopes(tokens.scope);
    const missing = scopes.filter((s) => !granted.includes(s));
    if (missing.length > 0) {
      throw new AuthCliError(
        `These permissions were not granted: ${missing.join(', ')}. Run the command again and leave every box ticked on the consent screen.`,
      );
    }
    let accountEmail: string | undefined;
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      accountEmail = ticket.getPayload()?.email ?? undefined;
    }
    await store.write({
      type: 'authorized_user',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      scope: granted.join(' '),
      ...(accountEmail && { account_email: accountEmail }),
      created_at: new Date().toISOString(),
    });
    say(
      `\nAuthenticated as ${accountEmail ?? '(unknown account)'}. Token saved to ${store.location}.`,
    );
    if (process.platform === 'win32') {
      say('Note: on Windows the token file is protected by your user profile permissions only.');
    }
    if (config.google.tokenJson) {
      say(
        `Note: ${TOKEN_JSON_ENV} is set and takes precedence over this file. Update it with the new token (see docs/deploymentPlan.md, step 1).`,
      );
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

/** `auth --status`: shows the stored grant and proves the refresh token still works. */
export async function runAuthStatus(opts: {
  config: Config;
  out?: Writer;
  store?: TokenStore;
}): Promise<boolean> {
  const out = opts.out ?? process.stderr;
  const say = (line: string) => out.write(`${line}\n`);
  const store = opts.store ?? tokenStoreFor(opts.config.google);
  let token;
  try {
    token = await store.read();
  } catch (err) {
    if (err instanceof TokenFileError) {
      say(`${err.message} Run \`npx gmail-docs-mcp auth\` to sign in.`);
      return false;
    }
    throw err;
  }
  const granted = parseScopes(token.scope);
  const missing = requiredScopes(opts.config).filter((s) => !granted.includes(s));
  say(`Token file: ${store.location}`);
  say(`Account:    ${token.account_email ?? '(unknown)'}`);
  say(`Scopes:     ${granted.join(' ')}`);
  if (missing.length)
    say(`Missing:    ${missing.join(' ')} (run \`npx gmail-docs-mcp auth\` again)`);
  const client = new OAuth2Client({
    clientId: opts.config.google.clientId ?? token.client_id,
    clientSecret: opts.config.google.clientSecret ?? token.client_secret,
  });
  client.setCredentials({ refresh_token: token.refresh_token });
  try {
    await client.getAccessToken();
    say('Refresh:    OK');
    return missing.length === 0;
  } catch (err) {
    const info = googleErrorInfo(err);
    say(
      `Refresh:    FAILED (${info.oauthError ?? info.message ?? 'unknown error'}). Run \`npx gmail-docs-mcp auth\` again.`,
    );
    return false;
  }
}
