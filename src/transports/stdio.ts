import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { installStdoutGuard } from '../lib/logger.js';
import type { Deps } from '../lib/tool.js';
import { createServerFactory } from '../server.js';

/** Serves MCP over stdio. Only JSON-RPC reaches stdout (C9). */
export function startStdio(deps: Deps): StdioServerHandle {
  installStdoutGuard(deps.logger);
  const handle = serveStdio(createServerFactory(deps, 'stdio'), {
    onerror: (error) => deps.logger.error('stdio transport error', { error }),
  });
  deps.logger.info('gmail-docs-mcp listening on stdio');
  return handle;
}
