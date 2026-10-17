import { createHash, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import type { Config } from '../config.js';
import type { Deps } from '../lib/tool.js';
import { createServerFactory } from '../server.js';

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export class HttpStartupError extends Error {}

/** Refuses to expose the server on a non-loopback interface without a bearer token (PS §8.2). */
export function assertSafeBind(config: Config): void {
  if (!isLoopbackHost(config.http.host) && !config.http.bearerToken) {
    throw new HttpStartupError(
      `Refusing to listen on ${config.http.host} without MCP_HTTP_BEARER_TOKEN. ` +
        'Set a long random token, or bind to 127.0.0.1.',
    );
  }
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time bearer check. */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  return timingSafeEqual(digest(m[1]!.trim()), digest(expected));
}

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('['))
    return hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase();
  return hostHeader.split(':')[0]!.toLowerCase();
}

function reject(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
}

/** Host, Origin and bearer checks in front of /mcp. Returns false after answering the request. */
export function createRequestGuard(
  config: Config,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const loopback = isLoopbackHost(config.http.host);
  const allowedHosts = new Set([...(loopback ? LOOPBACK_NAMES : []), ...config.http.allowedHosts]);
  const enforceHost = loopback || config.http.allowedHosts.length > 0;
  const allowedOrigins = new Set(
    config.http.allowedOrigins.map((o) => o.replace(/\/$/, '').toLowerCase()),
  );

  return (req, res) => {
    // 1. Host header (DNS-rebinding defense).
    if (enforceHost) {
      const host = req.headers.host;
      if (!host || !allowedHosts.has(hostnameOf(host))) {
        reject(res, 403, 'Forbidden: Host not allowed. Add it to MCP_HTTP_ALLOWED_HOSTS.');
        return false;
      }
    }
    // 2. Origin: absent (server-to-server) is fine; present must be allowed.
    const origin = req.headers.origin;
    if (origin) {
      let ok = allowedOrigins.has(origin.replace(/\/$/, '').toLowerCase());
      if (!ok && loopback) {
        try {
          ok = isLoopbackHost(new URL(origin).hostname);
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        reject(res, 403, 'Forbidden: Origin not allowed. Add it to MCP_HTTP_ALLOWED_ORIGINS.');
        return false;
      }
    }
    // 3. Bearer token.
    if (
      config.http.bearerToken &&
      !bearerMatches(req.headers.authorization, config.http.bearerToken)
    ) {
      reject(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
      return false;
    }
    return true;
  };
}

export interface HttpServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Stateless Streamable HTTP on a single /mcp endpoint (C1), serving both protocol eras (C2). */
export async function startHttp(deps: Deps): Promise<HttpServerHandle> {
  const { config, logger } = deps;
  assertSafeBind(config);
  const handler = createMcpHandler(createServerFactory(deps, 'http'), {
    legacy: 'stateless',
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (error) => logger.warn('http request rejected', { error }),
  });
  const mcp = toNodeHandler(handler, {
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (error) => logger.error('http handler error', { error }),
  });
  const guard = createRequestGuard(config);

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (path !== '/mcp') {
      reject(res, 404, 'Not found. The MCP endpoint is /mcp.');
      return;
    }
    if (!guard(req, res)) return;
    // Node always sets `method` on server requests; the adapter's type just doesn't allow undefined.
    mcp(req as NodeIncomingMessageLike, res).catch((error: unknown) => {
      logger.error('unhandled http error', { error });
      if (!res.headersSent) reject(res, 500, 'Internal server error');
    });
  });
  server.requestTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.http.port, config.http.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const hostForUrl = config.http.host.includes(':') ? `[${config.http.host}]` : config.http.host;
  const url = `http://${hostForUrl}:${port}/mcp`;
  logger.info('gmail-docs-mcp listening on http', {
    url,
    auth: config.http.bearerToken ? 'bearer' : 'none',
  });

  return {
    url,
    port,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(() => {
          server.closeAllConnections();
          resolve();
        }, 10_000).unref();
      });
    },
  };
}
