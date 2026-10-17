import { afterEach, describe, expect, it, vi } from 'vitest';
import { installStdoutGuard, Logger, redact } from '../../src/lib/logger.js';
import { LogSink } from '../helpers/harness.js';

describe('Logger', () => {
  it('writes JSON lines at or above the level', () => {
    const sink = new LogSink();
    const log = new Logger('info', sink);
    log.debug('hidden');
    log.info('shown', { a: 1 });
    log.warn('w');
    log.error('e');
    expect(sink.lines).toHaveLength(3);
    const rec = JSON.parse(sink.lines[0]!);
    expect(rec).toMatchObject({ level: 'info', msg: 'shown', a: 1 });
    log.setLevel('debug');
    log.debug('now');
    expect(sink.lines).toHaveLength(4);
  });

  it('redacts secrets and content recursively', () => {
    const out = redact({
      access_token: 'x',
      nested: {
        Authorization: 'Bearer y',
        body: 'secret mail',
        text: 'doc text',
        ok: 1,
        list: [{ refresh_token: 'z' }],
      },
      err: new Error('boom'),
    }) as {
      access_token: string;
      nested: {
        Authorization: string;
        body: string;
        text: string;
        ok: number;
        list: { refresh_token: string }[];
      };
      err: unknown;
    };
    expect(out.access_token).toBe('[redacted]');
    expect(out.nested.Authorization).toBe('[redacted]');
    expect(out.nested.body).toBe('[redacted]');
    expect(out.nested.text).toBe('[redacted]');
    expect(out.nested.ok).toBe(1);
    expect(out.nested.list[0]!.refresh_token).toBe('[redacted]');
    expect(out.err).toEqual({ name: 'Error', message: 'boom' });
  });

  it('record() writes verbatim', () => {
    const sink = new LogSink();
    new Logger('error', sink).record({ type: 'audit', x: 1 });
    expect(JSON.parse(sink.lines[0]!)).toEqual({ type: 'audit', x: 1 });
  });
});

describe('installStdoutGuard', () => {
  const orig = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  afterEach(() => Object.assign(console, orig));

  it('routes console output to the logger instead of stdout', () => {
    const sink = new LogSink();
    const stdout = vi.spyOn(process.stdout, 'write');
    installStdoutGuard(new Logger('debug', sink));
    console.log('hello', { a: 1 });
    console.info('i');
    console.debug('d');
    console.warn('w');
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
    expect(sink.lines.map((l) => JSON.parse(l).msg)).toEqual(['hello {"a":1}', 'i', 'd', 'w']);
  });
});
