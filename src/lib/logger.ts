/**
 * Structured JSON logger that writes to stderr only (C9). stdout is reserved
 * for JSON-RPC in stdio mode.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values must never be logged (tokens, email bodies, appended text). */
const SENSITIVE_KEY = /token|secret|authorization|password|^body$|^text$|^raw$|^rows$|^html$/i;

export interface Writer {
  write(chunk: string): unknown;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export class Logger {
  constructor(
    private level: LogLevel = 'info',
    private readonly out: Writer = process.stderr,
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log('error', msg, fields);
  }

  /** Writes a pre-built record verbatim (already redacted by the caller), e.g. audit lines. */
  record(record: Record<string, unknown>): void {
    this.out.write(`${JSON.stringify(record)}\n`);
  }

  private log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const safe = fields ? (redact(fields) as Record<string, unknown>) : {};
    this.out.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...safe })}\n`);
  }
}

export const logger = new Logger();

/**
 * Safety net for stdio mode: route any stray console output from dependencies
 * to stderr so it can't corrupt the JSON-RPC stream.
 */
export function installStdoutGuard(target: Logger = logger): void {
  const toStderr =
    (level: LogLevel) =>
    (...args: unknown[]) =>
      target[level](args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = toStderr('info');
  console.info = toStderr('info');
  console.debug = toStderr('debug');
  console.warn = toStderr('warn');
}
