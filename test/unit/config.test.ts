import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  defaultTokenPath,
  expandHome,
  loadConfig,
  requiredScopes,
  SCOPES,
} from '../../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      transport: 'stdio',
      http: { host: '127.0.0.1', port: 3333, allowedOrigins: [], allowedHosts: [] },
      email: { dryRun: false, allowedDomains: [], maxRecipients: 20, maxPerHour: 30 },
      docs: { allowedIds: [], maxAppendChars: 50_000, maxTableRows: 100, maxTableCols: 20 },
      enableDrafts: false,
      logLevel: 'info',
    });
    expect(c.google.tokenPath).toBe(defaultTokenPath());
    expect(c.google.timeoutMs).toBe(20_000);
    expect(c.auditLogPath).toBeUndefined();
    expect(c.http.bearerToken).toBeUndefined();
  });

  it('parses every variable', () => {
    const c = loadConfig({
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_TOKEN_PATH: '~/tok.json',
      MCP_TRANSPORT: 'HTTP',
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_HTTP_PORT: '8080',
      MCP_HTTP_BEARER_TOKEN: 'tok',
      MCP_HTTP_ALLOWED_ORIGINS: 'https://a.com, https://b.com',
      MCP_HTTP_ALLOWED_HOSTS: 'Example.NGROK.app',
      EMAIL_DRY_RUN: '1',
      EMAIL_ALLOWED_DOMAINS: 'Example.com, partner.com,,',
      EMAIL_MAX_RECIPIENTS: '5',
      EMAIL_MAX_PER_HOUR: '10',
      GMAIL_SEND_AS: 'alias@example.com',
      DOCS_ALLOWED_IDS: 'a,b',
      DOCS_MAX_APPEND_CHARS: '100',
      ENABLE_DRAFTS: 'TRUE',
      LOG_LEVEL: 'debug',
      AUDIT_LOG_PATH: '~/audit.jsonl',
    });
    expect(c.google).toMatchObject({
      clientId: 'id',
      clientSecret: 'secret',
      tokenPath: path.join(os.homedir(), 'tok.json'),
    });
    expect(c.transport).toBe('http');
    expect(c.http).toEqual({
      host: '0.0.0.0',
      port: 8080,
      bearerToken: 'tok',
      allowedOrigins: ['https://a.com', 'https://b.com'],
      allowedHosts: ['example.ngrok.app'],
    });
    expect(c.email).toEqual({
      dryRun: true,
      allowedDomains: ['example.com', 'partner.com'],
      maxRecipients: 5,
      maxPerHour: 10,
      sendAs: 'alias@example.com',
    });
    expect(c.docs.allowedIds).toEqual(['a', 'b']);
    expect(c.docs.maxAppendChars).toBe(100);
    expect(c.enableDrafts).toBe(true);
    expect(c.logLevel).toBe('debug');
    expect(c.auditLogPath).toBe(path.join(os.homedir(), 'audit.jsonl'));
  });

  it('lets CLI flags override env', () => {
    const c = loadConfig(
      { MCP_TRANSPORT: 'stdio', MCP_HTTP_PORT: '1' },
      { transport: 'http', port: '9999', host: '::1' },
    );
    expect(c.transport).toBe('http');
    expect(c.http.port).toBe(9999);
    expect(c.http.host).toBe('::1');
  });

  it('resolves the HTTP port as --port > MCP_HTTP_PORT > PORT > 3333 (Railway sets PORT)', () => {
    expect(loadConfig({}).http.port).toBe(3333);
    expect(loadConfig({ PORT: '8080' }).http.port).toBe(8080);
    expect(loadConfig({ PORT: '8080', MCP_HTTP_PORT: '4000' }).http.port).toBe(4000);
    expect(loadConfig({ PORT: '8080', MCP_HTTP_PORT: '4000' }, { port: '5000' }).http.port).toBe(
      5000,
    );
    expect(loadConfig({ PORT: '' }).http.port).toBe(3333);
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT: expected an integer/);
  });

  it('reads GOOGLE_TOKEN_JSON without exposing it in errors', () => {
    expect(loadConfig({}).google.tokenJson).toBeUndefined();
    expect(loadConfig({ GOOGLE_TOKEN_JSON: ' abc== ' }).google.tokenJson).toBe('abc==');
    try {
      loadConfig({ GOOGLE_TOKEN_JSON: 'super-secret-token', EMAIL_DRY_RUN: 'maybe' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-token');
    }
  });

  it('reports every invalid value', () => {
    try {
      loadConfig({
        EMAIL_DRY_RUN: 'yes',
        EMAIL_MAX_RECIPIENTS: '0',
        MCP_TRANSPORT: 'sse',
        LOG_LEVEL: 'loud',
        MCP_HTTP_PORT: 'abc',
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const issues = (e as ConfigError).issues.join('\n');
      expect(issues).toMatch(/EMAIL_DRY_RUN: expected true or false, got "yes"/);
      expect(issues).toMatch(/EMAIL_MAX_RECIPIENTS: expected an integer between 1 and 100/);
      expect(issues).toMatch(/MCP_TRANSPORT/);
      expect(issues).toMatch(/LOG_LEVEL/);
      expect(issues).toMatch(/MCP_HTTP_PORT/);
    }
  });
});

describe('helpers', () => {
  it('expands ~', () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('~/x')).toBe(path.join(os.homedir(), 'x'));
    expect(expandHome('/abs')).toBe('/abs');
  });
  it('derives required scopes', () => {
    expect(requiredScopes({ enableDrafts: false })).toEqual([
      SCOPES.gmailSend,
      SCOPES.documents,
      SCOPES.openid,
      SCOPES.email,
    ]);
    expect(requiredScopes({ enableDrafts: true })).toContain(SCOPES.gmailCompose);
  });
});
