import type { docs_v1 } from '@googleapis/docs';
import type { gmail_v1 } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import type { Config } from '../config.js';
import { REAUTH_COMMAND, ToolError } from '../lib/errors.js';
import { TokenFileError, type StoredToken, type TokenStore } from './tokenStore.js';

/** Per-call request options: our own retry wrapper handles retries (PS §10). */
export interface GoogleRequestOptions {
  timeout: number;
  retry: false;
}

/** What tools need from Google. Never opens a browser or prompts (C11). */
export interface GoogleClient {
  gmail(): Promise<gmail_v1.Gmail>;
  docs(): Promise<docs_v1.Docs>;
  /** Throws SCOPE_MISSING if the stored grant lacks any of `scopes`. */
  ensureScopes(scopes: readonly string[]): Promise<void>;
  accountEmail(): Promise<string | undefined>;
  readonly requestOptions: GoogleRequestOptions;
}

interface Loaded {
  version: string | undefined;
  token: StoredToken;
  auth: OAuth2Client;
  gmail: gmail_v1.Gmail;
  docs: docs_v1.Docs;
  scopes: Set<string>;
}

export interface GoogleClientOptions {
  store: TokenStore;
  config: Pick<Config, 'google'>;
  /** Override for tests (e.g. pre-seeded access tokens). */
  makeAuth?: (token: StoredToken) => OAuth2Client;
}

export function createGoogleClient(opts: GoogleClientOptions): GoogleClient {
  const { store, config } = opts;
  let cached: Loaded | undefined;

  async function load(): Promise<Loaded> {
    const version = await store.version();
    if (cached && cached.version === version) return cached;
    let token: StoredToken;
    try {
      token = await store.read();
    } catch (err) {
      if (err instanceof TokenFileError) {
        throw new ToolError(
          'AUTH_REQUIRED',
          err.kind === 'missing'
            ? `Not signed in to Google. Ask the server owner to run \`${REAUTH_COMMAND}\` in a terminal, then retry.`
            : `${err.message} Run \`${REAUTH_COMMAND}\` to sign in again.`,
        );
      }
      throw err;
    }
    const auth =
      opts.makeAuth?.(token) ??
      new OAuth2Client({
        clientId: config.google.clientId ?? token.client_id,
        clientSecret: config.google.clientSecret ?? token.client_secret,
      });
    if (!opts.makeAuth) auth.setCredentials({ refresh_token: token.refresh_token });
    // Loaded on first use so server startup (and `initialize`) stays fast.
    const [{ docs }, { gmail }] = await Promise.all([
      import('@googleapis/docs'),
      import('@googleapis/gmail'),
    ]);
    cached = {
      version,
      token,
      auth,
      gmail: gmail({ version: 'v1', auth }),
      docs: docs({ version: 'v1', auth }),
      scopes: new Set(token.scope.split(/\s+/).filter(Boolean)),
    };
    return cached;
  }

  return {
    requestOptions: { timeout: config.google.timeoutMs, retry: false },
    async gmail() {
      return (await load()).gmail;
    },
    async docs() {
      return (await load()).docs;
    },
    async accountEmail() {
      try {
        return (await load()).token.account_email;
      } catch {
        return undefined;
      }
    },
    async ensureScopes(scopes) {
      const { scopes: granted } = await load();
      const missing = scopes.filter((s) => !granted.has(s));
      if (missing.length > 0) {
        throw new ToolError(
          'SCOPE_MISSING',
          `The Google sign-in is missing permission(s): ${missing.join(', ')}. ` +
            `Run \`${REAUTH_COMMAND}\` again to grant them.`,
        );
      }
    },
  };
}
