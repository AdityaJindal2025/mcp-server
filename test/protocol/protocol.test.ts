import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttp, type HttpServerHandle } from '../../src/transports/http.js';
import { para } from '../helpers/fakeDocs.js';
import { makeHarness, textOf, type Harness } from '../helpers/harness.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg';
const VERSIONS = { legacy: '2025-11-25', modern: '2026-07-28' } as const;

let h: Harness | undefined;
let http: HttpServerHandle | undefined;
let httpClient: Client | undefined;
afterEach(async () => {
  await httpClient?.close();
  await http?.close();
  await h?.close();
  h = http = httpClient = undefined;
});

async function exerciseAllTools(
  call: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ isError?: boolean | undefined; content: unknown[] }>,
) {
  const send = await call('gmail_send_email', { to: ['a@example.com'], subject: 'S', body: 'B' });
  expect(send.isError).toBeFalsy();
  const info = await call('gdocs_get_document_info', { document: ID });
  expect(info.isError).toBeFalsy();
  const append = await call('gdocs_append_text', { document: ID, text: 'hello' });
  expect(append.isError).toBeFalsy();
  const table = await call('gdocs_append_table', { document: ID, rows: [['a']] });
  expect(table.isError).toBeFalsy();
  const draft = await call('gmail_create_draft', {
    to: ['a@example.com'],
    subject: 'S',
    body: 'B',
  });
  expect(draft.isError).toBeFalsy();
}

for (const era of ['legacy', 'modern'] as const) {
  describe(`protocol ${VERSIONS[era]}`, () => {
    it('in-memory (stdio entry): negotiates, lists and calls every tool', async () => {
      h = await makeHarness({ protocol: era, env: { ENABLE_DRAFTS: 'true' } });
      h.docs.add(ID, 'D', [{ body: [para('x')] }]);
      expect(h.client.getNegotiatedProtocolVersion()).toBe(VERSIONS[era]);
      const { tools } = await h.client.listTools();
      expect(tools).toHaveLength(5);
      expect(h.client.getServerCapabilities()).toEqual(
        expect.objectContaining({ tools: expect.any(Object) }),
      );
      expect(h.client.getServerCapabilities()?.resources).toBeUndefined();
      expect(h.client.getServerCapabilities()?.prompts).toBeUndefined();
      await exerciseAllTools(h.call);
    });

    it('Streamable HTTP (stateless): negotiates, lists and calls every tool', async () => {
      h = await makeHarness({
        env: { ENABLE_DRAFTS: 'true', MCP_HTTP_PORT: '0', MCP_HTTP_BEARER_TOKEN: 'secret-token' },
      });
      h.docs.add(ID, 'D', [{ body: [para('x')] }]);
      http = await startHttp(h.deps);
      httpClient = new Client(
        { name: 'http-test', version: '1' },
        { versionNegotiation: { mode: era === 'modern' ? { pin: VERSIONS.modern } : 'legacy' } },
      );
      await httpClient.connect(
        new StreamableHTTPClientTransport(new URL(http.url), {
          requestInit: { headers: { Authorization: 'Bearer secret-token' } },
        }),
      );
      expect(httpClient.getNegotiatedProtocolVersion()).toBe(VERSIONS[era]);
      expect((await httpClient.listTools()).tools).toHaveLength(5);
      const c = httpClient;
      await exerciseAllTools((name, args) => c.callTool({ name, arguments: args }) as never);
      expect(h.audit.events.every((e) => e.transport === 'http')).toBe(true);
      // S4: headless append over HTTP.
      const r = await c.callTool({
        name: 'gdocs_append_text',
        arguments: { document: ID, text: 'metrics' },
      });
      expect(textOf(r as never)).toMatch(/^Appended 7 characters/);
    });
  });
}
