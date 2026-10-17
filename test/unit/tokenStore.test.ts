import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGoogleClient } from '../../src/auth/googleClient.js';
import { FileTokenStore, TokenFileError } from '../../src/auth/tokenStore.js';
import { loadConfig, SCOPES } from '../../src/config.js';

let dir: string;
beforeEach(() => (dir = mkdtempSync(path.join(os.tmpdir(), 'gdm-tok-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const token = {
  type: 'authorized_user' as const,
  client_id: 'cid',
  client_secret: 'cs',
  refresh_token: 'rt',
  scope: `${SCOPES.gmailSend} ${SCOPES.documents}`,
  account_email: 'me@example.com',
};

it('writes atomically with 0600 and reads back', async () => {
  const store = new FileTokenStore(path.join(dir, 'a', 'b', 'token.json'));
  expect(await store.version()).toBeUndefined();
  await store.write(token);
  expect(await store.read()).toEqual(token);
  expect(await store.version()).toBeTypeOf('string');
  if (process.platform !== 'win32') expect(statSync(store.location).mode & 0o777).toBe(0o600);
});

it('reports missing and malformed files', async () => {
  const store = new FileTokenStore(path.join(dir, 'token.json'));
  await expect(store.read()).rejects.toMatchObject({ kind: 'missing' });
  writeFileSync(store.location, '{nope');
  await expect(store.read()).rejects.toMatchObject({ kind: 'malformed' });
  writeFileSync(store.location, '{"type":"authorized_user"}');
  await expect(store.read()).rejects.toBeInstanceOf(TokenFileError);
});

it('googleClient maps token problems to actionable errors and checks scopes', async () => {
  const tokenPath = path.join(dir, 'token.json');
  const config = loadConfig({ GOOGLE_TOKEN_PATH: tokenPath });
  const store = new FileTokenStore(tokenPath);
  const google = createGoogleClient({ store, config });
  await expect(google.docs()).rejects.toMatchObject({
    code: 'AUTH_REQUIRED',
    message: expect.stringContaining('npx gmail-docs-mcp auth'),
  });
  expect(await google.accountEmail()).toBeUndefined();
  writeFileSync(tokenPath, 'garbage');
  await expect(google.gmail()).rejects.toMatchObject({
    code: 'AUTH_REQUIRED',
    message: expect.stringContaining('not valid JSON'),
  });

  await store.write(token);
  await expect(google.ensureScopes([SCOPES.gmailSend])).resolves.toBeUndefined();
  await expect(google.ensureScopes([SCOPES.gmailCompose])).rejects.toMatchObject({
    code: 'SCOPE_MISSING',
    message: expect.stringContaining(SCOPES.gmailCompose),
  });
  expect(await google.accountEmail()).toBe('me@example.com');
  expect(google.requestOptions).toEqual({ timeout: 20000, retry: false });
  expect(await google.docs()).toBe(await google.docs());
});
