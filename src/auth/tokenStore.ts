import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

/**
 * Stored credentials. Uses Google's `authorized_user` shape (so the file also
 * works with other Google tooling) plus our own metadata. No access token is
 * stored (D9): access tokens are minted from the refresh token on demand.
 */
export const StoredTokenSchema = z.object({
  type: z.literal('authorized_user'),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  scope: z.string(),
  account_email: z.string().optional(),
  created_at: z.string().optional(),
});

export type StoredToken = z.infer<typeof StoredTokenSchema>;

export class TokenFileError extends Error {
  constructor(
    public readonly kind: 'missing' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'TokenFileError';
  }
}

export interface TokenStore {
  /** Human-readable location, for messages. */
  readonly location: string;
  read(): Promise<StoredToken>;
  write(token: StoredToken): Promise<void>;
  /** Changes whenever the stored token changes; used to pick up a re-run of `auth`. */
  version(): Promise<string | undefined>;
}

export class FileTokenStore implements TokenStore {
  constructor(public readonly location: string) {}

  async read(): Promise<StoredToken> {
    let raw: string;
    try {
      raw = await fs.readFile(this.location, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TokenFileError('missing', `No Google token found at ${this.location}.`);
      }
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new TokenFileError(
        'malformed',
        `The token file at ${this.location} is not valid JSON.`,
      );
    }
    const parsed = StoredTokenSchema.safeParse(json);
    if (!parsed.success) {
      throw new TokenFileError(
        'malformed',
        `The token file at ${this.location} is missing required fields.`,
      );
    }
    return parsed.data;
  }

  /** Atomic write with 0600 permissions (best effort on Windows, where chmod is a no-op). */
  async write(token: StoredToken): Promise<void> {
    const dir = path.dirname(this.location);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.location}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(tmp, 0o600).catch(() => undefined);
    await fs.rename(tmp, this.location);
  }

  async version(): Promise<string | undefined> {
    try {
      const st = await fs.stat(this.location);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return undefined;
    }
  }
}

export const TOKEN_JSON_ENV = 'GOOGLE_TOKEN_JSON';

/**
 * Read-only store backed by the GOOGLE_TOKEN_JSON environment variable, for
 * platforms without secret files (e.g. Railway). Accepts the token file's
 * contents as raw JSON or base64. Error messages name the variable but never
 * echo its value.
 */
export class EnvTokenStore implements TokenStore {
  readonly location = `${TOKEN_JSON_ENV} environment variable`;

  constructor(private readonly value: string) {}

  async read(): Promise<StoredToken> {
    const raw = this.value.trim();
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TokenFileError(
        'malformed',
        `The ${this.location} is not valid JSON or base64-encoded JSON.`,
      );
    }
    const parsed = StoredTokenSchema.safeParse(json);
    if (!parsed.success) {
      throw new TokenFileError(
        'malformed',
        `The token in the ${this.location} is missing required fields.`,
      );
    }
    return parsed.data;
  }

  async write(): Promise<void> {
    throw new Error(
      `Cannot save a token to the ${this.location}. Run \`auth\` on a workstation and update the variable instead.`,
    );
  }

  async version(): Promise<string | undefined> {
    // The environment can't change without a restart.
    return 'env';
  }
}

/** GOOGLE_TOKEN_JSON wins over GOOGLE_TOKEN_PATH when both are set. */
export function tokenStoreFor(google: { tokenPath: string; tokenJson?: string }): TokenStore {
  return google.tokenJson
    ? new EnvTokenStore(google.tokenJson)
    : new FileTokenStore(google.tokenPath);
}
