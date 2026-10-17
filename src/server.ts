import { createRequire } from 'node:module';
import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { createGoogleClient, type GoogleClient } from './auth/googleClient.js';
import { FileTokenStore } from './auth/tokenStore.js';
import type { Config } from './config.js';
import { FileAudit, StderrAudit, type AuditSink } from './lib/audit.js';
import { IdempotencyCache } from './lib/idempotency.js';
import { logger as defaultLogger, type Logger } from './lib/logger.js';
import { SlidingWindowLimiter } from './lib/rateLimiter.js';
import { registerTool, type Deps, type ToolOutput } from './lib/tool.js';
import { appendTableTool } from './tools/docs/appendTable.js';
import { appendTextTool } from './tools/docs/appendText.js';
import { getDocumentInfoTool } from './tools/docs/getDocumentInfo.js';
import { createDraftTool } from './tools/gmail/createDraft.js';
import { sendEmailTool } from './tools/gmail/sendEmail.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
export const SERVER_NAME = 'gmail-docs-mcp';
export const SERVER_VERSION = pkg.version;

const INSTRUCTIONS =
  'Tools to send email from, and append to Google Docs as, one connected Google account. Write tools have real side effects: email sends cannot be undone.';

export interface DepsOverrides {
  google?: GoogleClient;
  audit?: AuditSink;
  logger?: Logger;
  now?: () => number;
}

/** Creates the long-lived dependencies shared across connections/requests. */
export function createDeps(config: Config, overrides: DepsOverrides = {}): Deps {
  const logger = overrides.logger ?? defaultLogger;
  const now = overrides.now ?? Date.now;
  return {
    config,
    logger,
    google:
      overrides.google ??
      createGoogleClient({ store: new FileTokenStore(config.google.tokenPath), config }),
    audit:
      overrides.audit ??
      (config.auditLogPath ? new FileAudit(config.auditLogPath, logger) : new StderrAudit(logger)),
    limiter: new SlidingWindowLimiter(config.email.maxPerHour, 60 * 60 * 1000, now),
    idempotency: new IdempotencyCache<ToolOutput<unknown>>(24 * 60 * 60 * 1000, 10_000, now),
  };
}

/** Registers the tools for this configuration on a fresh McpServer (tools only, C3). */
export function buildServer(deps: Deps, transport: 'stdio' | 'http'): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const ctx = { ...deps, transport };
  registerTool(server, sendEmailTool, ctx);
  registerTool(server, getDocumentInfoTool, ctx);
  registerTool(server, appendTextTool, ctx);
  registerTool(server, appendTableTool, ctx);
  if (deps.config.enableDrafts) registerTool(server, createDraftTool, ctx);
  return server;
}

/**
 * The factory handed to the SDK entries (`serveStdio` / `createMcpHandler`),
 * which serve both protocol eras (2025-11-25 and 2026-07-28) from it (C2).
 */
export function createServerFactory(deps: Deps, transport: 'stdio' | 'http'): McpServerFactory {
  return () => buildServer(deps, transport);
}
