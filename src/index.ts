import { parseArgs } from 'node:util';
import { AuthCliError, runAuthCli, runAuthStatus } from './auth/authCli.js';
import { ConfigError, loadConfig, loadDotEnv, type Config } from './config.js';
import { logger } from './lib/logger.js';
import { createDeps, SERVER_VERSION } from './server.js';
import { HttpStartupError, startHttp } from './transports/http.js';
import { startStdio } from './transports/stdio.js';

const USAGE = `gmail-docs-mcp ${SERVER_VERSION}: MCP server for sending Gmail and appending to Google Docs

Usage:
  gmail-docs-mcp auth                          One-time Google sign-in
  gmail-docs-mcp auth --status                 Show the stored sign-in and check it still works
  gmail-docs-mcp [--transport stdio]           Serve over stdio (default)
  gmail-docs-mcp --transport http [--host H] [--port P]
                                               Serve Streamable HTTP at /mcp

Configuration is read from environment variables (and ./.env). See .env.example.`;

const err = (line: string) => process.stderr.write(`${line}\n`);

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        transport: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        status: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    err(USAGE);
    return 0;
  }
  if (values.version) {
    err(SERVER_VERSION);
    return 0;
  }
  const command = positionals[0];
  if (command !== undefined && command !== 'auth') {
    err(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }

  loadDotEnv();
  let config: Config;
  try {
    config = loadConfig(process.env, {
      ...(values.transport !== undefined && { transport: values.transport }),
      ...(values.port !== undefined && { port: values.port }),
      ...(values.host !== undefined && { host: values.host }),
    });
  } catch (e) {
    if (e instanceof ConfigError) {
      err(e.message);
      return 2;
    }
    throw e;
  }
  logger.setLevel(config.logLevel);

  if (command === 'auth') {
    try {
      if (values.status) return (await runAuthStatus({ config })) ? 0 : 1;
      await runAuthCli({ config });
      return 0;
    } catch (e) {
      if (e instanceof AuthCliError) {
        err(e.message);
        return 1;
      }
      throw e;
    }
  }

  const deps = createDeps(config);
  if (config.transport === 'http') {
    let handle;
    try {
      handle = await startHttp(deps);
    } catch (e) {
      if (e instanceof HttpStartupError) {
        logger.error(e.message);
        return 2;
      }
      throw e;
    }
    const shutdown = () => {
      logger.info('shutting down');
      void handle.close().then(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return -1; // keep running
  }

  const handle = startStdio(deps);
  const shutdown = () => void handle.close().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return -1;
}

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { error: reason });
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', { error });
  process.exit(1);
});

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e: unknown) => {
    logger.error('fatal', { error: e });
    process.exit(1);
  },
);
