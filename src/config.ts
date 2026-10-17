import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';

export const SCOPES = {
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  gmailCompose: 'https://www.googleapis.com/auth/gmail.compose',
  documents: 'https://www.googleapis.com/auth/documents',
  // D1: non-sensitive identity scopes so error messages can name the connected account.
  openid: 'openid',
  email: 'https://www.googleapis.com/auth/userinfo.email',
} as const;

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const s = v.trim().toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      ctx.addIssue({ code: 'custom', message: `expected true or false, got "${v}"` });
      return z.NEVER;
    });

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `expected an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

/** Like `int`, but `undefined` when unset, so callers can fall back to another variable. */
const optInt = (min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `expected an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const list = (lower = false) =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => (lower ? s.trim().toLowerCase() : s.trim()))
        .filter(Boolean),
    );

const str = () =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function defaultTokenPath(): string {
  return path.join(os.homedir(), '.config', 'gmail-docs-mcp', 'token.json');
}

const EnvSchema = z.object({
  GOOGLE_CLIENT_ID: str(),
  GOOGLE_CLIENT_SECRET: str(),
  GOOGLE_TOKEN_PATH: str(),
  // Token file contents (raw or base64 JSON) for hosts without secret files, e.g. Railway.
  GOOGLE_TOKEN_JSON: str(),

  MCP_TRANSPORT: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().toLowerCase() : 'stdio'))
    .pipe(z.enum(['stdio', 'http'])),
  MCP_HTTP_HOST: str(),
  MCP_HTTP_PORT: optInt(0, 65535),
  // Injected by platforms such as Railway; used when MCP_HTTP_PORT is unset.
  PORT: optInt(0, 65535),
  MCP_HTTP_BEARER_TOKEN: str(),
  MCP_HTTP_ALLOWED_ORIGINS: list(),
  MCP_HTTP_ALLOWED_HOSTS: list(true),

  EMAIL_DRY_RUN: bool(false),
  EMAIL_ALLOWED_DOMAINS: list(true),
  EMAIL_MAX_RECIPIENTS: int(20, 1, 100),
  EMAIL_MAX_PER_HOUR: int(30, 1, 10_000),
  GMAIL_SEND_AS: str(),

  DOCS_ALLOWED_IDS: list(),
  DOCS_MAX_APPEND_CHARS: int(50_000, 1, 1_000_000),
  DOCS_MAX_TABLE_ROWS: int(100, 1, 1000),
  DOCS_MAX_TABLE_COLS: int(20, 1, 20),

  ENABLE_DRAFTS: bool(false),

  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().toLowerCase() : 'info'))
    .pipe(z.enum(['debug', 'info', 'warn', 'error'])),
  AUDIT_LOG_PATH: str(),
  GOOGLE_TIMEOUT_MS: int(20_000, 1000, 120_000),
});

export interface Config {
  google: {
    clientId?: string;
    clientSecret?: string;
    tokenPath: string;
    /** When set, takes precedence over `tokenPath`. Never log this value. */
    tokenJson?: string;
    timeoutMs: number;
  };
  transport: 'stdio' | 'http';
  http: {
    host: string;
    port: number;
    bearerToken?: string;
    allowedOrigins: string[];
    allowedHosts: string[];
  };
  email: {
    dryRun: boolean;
    allowedDomains: string[];
    maxRecipients: number;
    maxPerHour: number;
    sendAs?: string;
  };
  docs: {
    allowedIds: string[];
    maxAppendChars: number;
    maxTableRows: number;
    maxTableCols: number;
  };
  enableDrafts: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  auditLogPath?: string;
}

export interface CliOverrides {
  transport?: string;
  port?: string;
  host?: string;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Loads `.env` from the working directory if present (Node >= 20.12). Existing env vars win. */
export function loadDotEnv(cwd = process.cwd()): void {
  const file = path.join(cwd, '.env');
  const load = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (existsSync(file) && typeof load === 'function') load(file);
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  cli: CliOverrides = {},
): Config {
  const merged = {
    ...env,
    ...(cli.transport !== undefined && { MCP_TRANSPORT: cli.transport }),
    ...(cli.port !== undefined && { MCP_HTTP_PORT: cli.port }),
    ...(cli.host !== undefined && { MCP_HTTP_HOST: cli.host }),
  };
  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  return {
    google: {
      ...(e.GOOGLE_CLIENT_ID && { clientId: e.GOOGLE_CLIENT_ID }),
      ...(e.GOOGLE_CLIENT_SECRET && { clientSecret: e.GOOGLE_CLIENT_SECRET }),
      tokenPath: path.resolve(expandHome(e.GOOGLE_TOKEN_PATH ?? defaultTokenPath())),
      ...(e.GOOGLE_TOKEN_JSON && { tokenJson: e.GOOGLE_TOKEN_JSON }),
      timeoutMs: e.GOOGLE_TIMEOUT_MS,
    },
    transport: e.MCP_TRANSPORT,
    http: {
      host: e.MCP_HTTP_HOST ?? '127.0.0.1',
      // --port (mapped onto MCP_HTTP_PORT above) > MCP_HTTP_PORT > PORT > 3333.
      port: e.MCP_HTTP_PORT ?? e.PORT ?? 3333,
      ...(e.MCP_HTTP_BEARER_TOKEN && { bearerToken: e.MCP_HTTP_BEARER_TOKEN }),
      allowedOrigins: e.MCP_HTTP_ALLOWED_ORIGINS,
      allowedHosts: e.MCP_HTTP_ALLOWED_HOSTS,
    },
    email: {
      dryRun: e.EMAIL_DRY_RUN,
      allowedDomains: e.EMAIL_ALLOWED_DOMAINS,
      maxRecipients: e.EMAIL_MAX_RECIPIENTS,
      maxPerHour: e.EMAIL_MAX_PER_HOUR,
      ...(e.GMAIL_SEND_AS && { sendAs: e.GMAIL_SEND_AS }),
    },
    docs: {
      allowedIds: e.DOCS_ALLOWED_IDS,
      maxAppendChars: e.DOCS_MAX_APPEND_CHARS,
      maxTableRows: e.DOCS_MAX_TABLE_ROWS,
      maxTableCols: e.DOCS_MAX_TABLE_COLS,
    },
    enableDrafts: e.ENABLE_DRAFTS,
    logLevel: e.LOG_LEVEL,
    ...(e.AUDIT_LOG_PATH && { auditLogPath: path.resolve(expandHome(e.AUDIT_LOG_PATH)) }),
  };
}

/** Scopes requested by `auth` and expected in the stored token. */
export function requiredScopes(config: Pick<Config, 'enableDrafts'>): string[] {
  const scopes: string[] = [SCOPES.gmailSend, SCOPES.documents, SCOPES.openid, SCOPES.email];
  if (config.enableDrafts) scopes.push(SCOPES.gmailCompose);
  return scopes;
}
