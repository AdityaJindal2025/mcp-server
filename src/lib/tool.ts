import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { GoogleClient } from '../auth/googleClient.js';
import type { Config } from '../config.js';
import type { AuditSink } from './audit.js';
import { internalError, toToolResult, ToolError } from './errors.js';
import { hashArgs, IdempotencyCache } from './idempotency.js';
import type { Logger } from './logger.js';
import type { SlidingWindowLimiter } from './rateLimiter.js';

/** C10: keep each tool response under ~25 KB. */
export const MAX_RESULT_BYTES = 25_000;

export interface ToolOutput<S> {
  text: string;
  structured: S;
}

/** Long-lived dependencies shared by every server instance (stdio connection or HTTP request). */
export interface Deps {
  config: Config;
  google: GoogleClient;
  audit: AuditSink;
  limiter: SlidingWindowLimiter;
  idempotency: IdempotencyCache<ToolOutput<unknown>>;
  logger: Logger;
}

export interface ToolContext extends Deps {
  transport: 'stdio' | 'http';
}

export interface ToolDefinition<I extends z.ZodObject, O extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  input: I;
  output: O;
  /** When true, an optional `client_request_id` input enables duplicate protection. */
  idempotent?: boolean;
  handler: (args: z.infer<I>, ctx: ToolContext) => Promise<ToolOutput<z.infer<O>>>;
}

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Backstop for C10: trims the text block if the serialized result is too large. */
export function boundResult(result: CallToolResult, logger?: Logger): CallToolResult {
  const size = utf8Length(JSON.stringify(result));
  if (size <= MAX_RESULT_BYTES) return result;
  const block = result.content[0];
  if (!block || block.type !== 'text') return result;
  const excess = size - MAX_RESULT_BYTES + 64;
  const keep = Math.max(0, block.text.length - excess);
  logger?.warn('tool result truncated', { bytes: size });
  return {
    ...result,
    content: [
      { type: 'text', text: `${block.text.slice(0, keep)}… [truncated]` },
      ...result.content.slice(1),
    ],
  };
}

/**
 * Runs a tool handler with the shared pipeline: idempotency → handler →
 * strict output check (C6) → bounded result (C10); any error becomes an
 * `isError` result (C7).
 */
export async function runTool<I extends z.ZodObject, O extends z.ZodObject>(
  def: ToolDefinition<I, O>,
  args: z.infer<I>,
  ctx: ToolContext,
): Promise<CallToolResult> {
  try {
    const exec = async (): Promise<ToolOutput<z.infer<O>>> => {
      const out = await def.handler(args, ctx);
      return { text: out.text, structured: def.output.parse(out.structured) as z.infer<O> };
    };

    let out: ToolOutput<z.infer<O>>;
    let cached = false;
    const requestId = (args as { client_request_id?: unknown }).client_request_id;
    if (def.idempotent && typeof requestId === 'string' && requestId.length > 0) {
      const r = await ctx.idempotency.run(
        `${def.name}:${requestId}`,
        hashArgs(args as Record<string, unknown>),
        exec as () => Promise<ToolOutput<unknown>>,
      );
      out = r.value as ToolOutput<z.infer<O>>;
      cached = r.cached;
    } else {
      out = await exec();
    }

    const text = cached
      ? `${out.text} (Returned the earlier result for this client_request_id; nothing was repeated.)`
      : out.text;
    return boundResult(
      {
        content: [{ type: 'text', text }],
        structuredContent: out.structured as Record<string, unknown>,
      },
      ctx.logger,
    );
  } catch (err) {
    const toolErr = err instanceof ToolError ? err : internalError(err);
    if (toolErr.code === 'INTERNAL') {
      ctx.logger.error('tool failed', {
        tool: def.name,
        ref: (toolErr as ToolError & { ref?: string }).ref,
        error: (toolErr as ToolError & { causeErr?: unknown }).causeErr,
      });
    } else {
      ctx.logger.info('tool returned error', { tool: def.name, code: toolErr.code });
    }
    return toToolResult(toolErr);
  }
}

export function registerTool<I extends z.ZodObject, O extends z.ZodObject>(
  server: McpServer,
  def: ToolDefinition<I, O>,
  ctx: ToolContext,
): void {
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      outputSchema: def.output,
      annotations: { title: def.title, ...def.annotations },
    },
    // The SDK has already validated `args` against `def.input`.
    ((args: z.infer<I>) => runTool(def, args, ctx)) as never,
  );
}
