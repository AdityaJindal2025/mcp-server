import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { loadConfig } from '../../src/config.js';
import { MemoryAudit } from '../../src/lib/audit.js';
import { ToolError } from '../../src/lib/errors.js';
import { Logger } from '../../src/lib/logger.js';
import {
  boundResult,
  MAX_RESULT_BYTES,
  runTool,
  type ToolContext,
  type ToolDefinition,
} from '../../src/lib/tool.js';
import { createDeps } from '../../src/server.js';
import { LogSink } from '../helpers/harness.js';

const sink = new LogSink();
const ctx: ToolContext = {
  ...createDeps(loadConfig({}), { audit: new MemoryAudit(), logger: new Logger('debug', sink) }),
  transport: 'stdio',
};

const input = z.object({ v: z.string(), client_request_id: z.string().optional() });
const output = z.object({ v: z.string() }).strict();
const def = (
  handler: ToolDefinition<typeof input, typeof output>['handler'],
): ToolDefinition<typeof input, typeof output> => ({
  name: 'gmail_test',
  title: 'T',
  description: 'T.',
  annotations: {},
  input,
  output,
  idempotent: true,
  handler,
});

describe('runTool', () => {
  it('returns text + structuredContent', async () => {
    const r = await runTool(
      def(async (a) => ({ text: 'ok', structured: { v: a.v } })),
      { v: 'x' },
      ctx,
    );
    expect(r).toEqual({ content: [{ type: 'text', text: 'ok' }], structuredContent: { v: 'x' } });
  });

  it('rejects extra output fields (C6) as an internal error', async () => {
    const r = await runTool(
      def(async () => ({ text: 'ok', structured: { v: 'x', extra: 1 } as never })),
      { v: 'x' },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(sink.lines.join('')).toMatch(/tool failed/);
  });

  it('turns ToolErrors into isError results', async () => {
    const r = await runTool(
      def(async () => {
        throw new ToolError('TOO_LARGE', 'too big');
      }),
      { v: 'x' },
      ctx,
    );
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'too big' }] });
  });

  it('replays cached results for the same client_request_id', async () => {
    let calls = 0;
    const d = def(async () => ({ text: `call ${++calls}`, structured: { v: 'x' } }));
    await runTool(d, { v: 'x', client_request_id: 'r1' }, ctx);
    const again = await runTool(d, { v: 'x', client_request_id: 'r1' }, ctx);
    expect(calls).toBe(1);
    expect((again.content[0] as { text: string }).text).toMatch(
      /^call 1 \(Returned the earlier result/,
    );
    const conflict = await runTool(d, { v: 'y', client_request_id: 'r1' }, ctx);
    expect(conflict.isError).toBe(true);
  });
});

describe('boundResult (C10)', () => {
  it('leaves small results alone', () => {
    const r = { content: [{ type: 'text' as const, text: 'hi' }] };
    expect(boundResult(r)).toBe(r);
  });
  it('truncates oversized text', () => {
    const r = boundResult({ content: [{ type: 'text', text: 'x'.repeat(40_000) }] });
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect((r.content[0] as { text: string }).text.endsWith('[truncated]')).toBe(true);
  });
  it('cannot trim non-text content', () => {
    const r = {
      content: [{ type: 'image' as const, data: 'x'.repeat(30_000), mimeType: 'image/png' }],
    };
    expect(boundResult(r)).toBe(r);
  });
});
