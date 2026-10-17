import { describe, expect, it } from 'vitest';
import {
  EnvTokenStore,
  FileTokenStore,
  TokenFileError,
  tokenStoreFor,
} from '../../src/auth/tokenStore.js';
import { SCOPES } from '../../src/config.js';

const token = {
  type: 'authorized_user' as const,
  client_id: 'cid',
  client_secret: 'very-secret-value',
  refresh_token: '1//refresh-secret',
  scope: `${SCOPES.gmailSend} ${SCOPES.documents}`,
  account_email: 'me@example.com',
};
const json = JSON.stringify(token);

describe('EnvTokenStore (GOOGLE_TOKEN_JSON)', () => {
  it('reads raw JSON', async () => {
    expect(await new EnvTokenStore(json).read()).toEqual(token);
    expect(await new EnvTokenStore(`  ${json}\n`).read()).toEqual(token);
  });

  it('reads base64 and base64url, including wrapped lines', async () => {
    const b64 = Buffer.from(json).toString('base64');
    expect(await new EnvTokenStore(b64).read()).toEqual(token);
    expect(await new EnvTokenStore(Buffer.from(json).toString('base64url')).read()).toEqual(token);
    expect(await new EnvTokenStore(b64.replace(/(.{60})/g, '$1\n')).read()).toEqual(token);
  });

  it('names the variable but never echoes its value on errors', async () => {
    const bad = [
      'not-json-or-base64 very-secret-value',
      Buffer.from('{"refresh_token":"1//refresh-secret"').toString('base64'),
      JSON.stringify({ ...token, refresh_token: undefined }),
    ];
    for (const value of bad) {
      const err = await new EnvTokenStore(value).read().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TokenFileError);
      expect((err as TokenFileError).kind).toBe('malformed');
      expect((err as Error).message).toContain('GOOGLE_TOKEN_JSON environment variable');
      expect((err as Error).message).not.toContain('secret');
    }
  });

  it('is read-only with a constant version', async () => {
    const store = new EnvTokenStore(json);
    await expect(store.write()).rejects.toThrow(/Run `auth` on a workstation/);
    expect(await store.version()).toBe(await store.version());
    expect(store.location).toBe('GOOGLE_TOKEN_JSON environment variable');
  });
});

describe('tokenStoreFor', () => {
  it('prefers GOOGLE_TOKEN_JSON over GOOGLE_TOKEN_PATH', () => {
    expect(tokenStoreFor({ tokenPath: '/x/token.json', tokenJson: json })).toBeInstanceOf(
      EnvTokenStore,
    );
    const file = tokenStoreFor({ tokenPath: '/x/token.json' });
    expect(file).toBeInstanceOf(FileTokenStore);
    expect(file.location).toBe('/x/token.json');
  });
});
