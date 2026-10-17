import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileAudit, sha256, StderrAudit, type AuditEvent } from '../../src/lib/audit.js';
import { Logger } from '../../src/lib/logger.js';
import { LogSink } from '../helpers/harness.js';

const event: AuditEvent = {
  tool: 'gdocs_append_text',
  transport: 'stdio',
  status: 'ok',
  doc_id: 'DOC',
  revision_id: 'rev-2',
  inserted_chars: 5,
  text_sha256: sha256('hello'),
};

let dir: string | undefined;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

it('hashes with sha256', () => {
  expect(sha256('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

it('writes audit lines to stderr regardless of log level', async () => {
  const sink = new LogSink();
  await new StderrAudit(new Logger('error', sink)).write(event);
  const rec = JSON.parse(sink.lines[0]!);
  expect(rec).toMatchObject({ type: 'audit', tool: 'gdocs_append_text', doc_id: 'DOC' });
  expect(rec.ts).toBeTypeOf('string');
});

it('appends JSONL to a 0600 file, serialized', async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gdm-audit-'));
  const file = path.join(dir, 'nested', 'audit.jsonl');
  const audit = new FileAudit(file, new Logger('error', new LogSink()));
  await Promise.all([audit.write(event), audit.write({ ...event, revision_id: 'rev-3' })]);
  const lines = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  expect(lines.map((l) => l.revision_id)).toEqual(['rev-2', 'rev-3']);
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
});

it('logs (not throws) when the audit file cannot be written', async () => {
  const sink = new LogSink();
  dir = mkdtempSync(path.join(os.tmpdir(), 'gdm-audit-'));
  const audit = new FileAudit(dir, new Logger('error', sink)); // a directory, not a file
  await audit.write(event);
  expect(sink.lines.join('')).toMatch(/audit write failed/);
});
