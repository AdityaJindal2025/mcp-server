import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  assertSafeBind,
  bearerMatches,
  isLoopbackHost,
  startHttp,
  type HttpServerHandle,
} from '../../src/transports/http.js';
import { makeHarness, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
let srv: HttpServerHandle | undefined;
afterEach(async () => {
  await srv?.close();
  await h?.close();
  h = srv = undefined;
});

const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  },
};

async function start(env: Record<string, string>) {
  h = await makeHarness({ env: { MCP_HTTP_PORT: '0', ...env } });
  srv = await startHttp(h.deps);
  return srv;
}

/** Reads a JSON-RPC response sent either as plain JSON or as a single SSE event. */
async function readRpc(res: Response): Promise<{ result: { serverInfo: { name: string } } }> {
  const text = await res.text();
  const data = text.trimStart().startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '');
  return JSON.parse(data);
}

function post(url: string, headers: Record<string, string> = {}, body: unknown = init) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('helpers', () => {
  it('detects loopback hosts', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]'])
      expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '10.0.0.1', 'example.com', '::'])
      expect(isLoopbackHost(h)).toBe(false);
  });
  it('compares bearer tokens', () => {
    expect(bearerMatches('Bearer abc', 'abc')).toBe(true);
    expect(bearerMatches('bearer  abc ', 'abc')).toBe(true);
    expect(bearerMatches('Bearer abd', 'abc')).toBe(false);
    expect(bearerMatches('Basic abc', 'abc')).toBe(false);
    expect(bearerMatches(undefined, 'abc')).toBe(false);
  });
  it('refuses a public bind without a bearer token', () => {
    expect(() => assertSafeBind(loadConfig({ MCP_HTTP_HOST: '0.0.0.0' }))).toThrow(
      /Refusing to listen on 0.0.0.0 without MCP_HTTP_BEARER_TOKEN/,
    );
    expect(() =>
      assertSafeBind(loadConfig({ MCP_HTTP_HOST: '0.0.0.0', MCP_HTTP_BEARER_TOKEN: 'x' })),
    ).not.toThrow();
    expect(() => assertSafeBind(loadConfig({}))).not.toThrow();
  });
});

describe('HTTP transport', () => {
  it('serves /healthz without auth and 404s other paths', async () => {
    const s = await start({ MCP_HTTP_BEARER_TOKEN: 'tok' });
    const base = s.url.replace(/\/mcp$/, '');
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it('requires the bearer token when configured', async () => {
    const s = await start({ MCP_HTTP_BEARER_TOKEN: 'tok' });
    const missing = await post(s.url);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect((await post(s.url, { authorization: 'Bearer wrong' })).status).toBe(401);
    const ok = await post(s.url, { authorization: 'Bearer tok' });
    expect(ok.status).toBe(200);
    expect((await readRpc(ok)).result.serverInfo.name).toBe('gmail-docs-mcp');
  });

  it('allows no auth on loopback when no token is set', async () => {
    const s = await start({});
    expect((await post(s.url)).status).toBe(200);
  });

  it('validates Origin (absent ok, loopback ok, unknown rejected, configured ok)', async () => {
    const s = await start({ MCP_HTTP_ALLOWED_ORIGINS: 'https://app.example.com' });
    expect((await post(s.url, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(s.url, { origin: 'not a url' })).status).toBe(403);
    expect((await post(s.url, { origin: 'http://localhost:6274' })).status).toBe(200);
    expect((await post(s.url, { origin: 'https://app.example.com' })).status).toBe(200);
  });

  it('validates the Host header against loopback names and MCP_HTTP_ALLOWED_HOSTS', async () => {
    const s = await start({ MCP_HTTP_ALLOWED_HOSTS: 'tunnel.example.com' });
    const url = new URL(s.url);
    const raw = async (host: string) => {
      const http = await import('node:http');
      return new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: url.hostname,
            port: url.port,
            path: '/mcp',
            method: 'POST',
            headers: {
              host,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify(init));
      });
    };
    expect(await raw('evil.example.com')).toBe(403);
    expect(await raw('tunnel.example.com')).toBe(200);
    expect(await raw(`localhost:${url.port}`)).toBe(200);
  });

  it('answers GET on /mcp with 405 in stateless mode', async () => {
    const s = await start({});
    expect((await fetch(s.url, { headers: { accept: 'text/event-stream' } })).status).toBe(405);
  });
});
