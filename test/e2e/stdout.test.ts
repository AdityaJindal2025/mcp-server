import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const entry = path.join(root, 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(entry))
    execFileSync(
      process.execPath,
      [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
      { cwd: root },
    );
}, 120_000);

/** C9: in stdio mode nothing but JSON-RPC may reach stdout, even with debug logging and errors. */
it('writes only JSON-RPC to stdout', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gdm-e2e-'));
  const child = spawn(process.execPath, [entry], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      LOG_LEVEL: 'debug',
      GOOGLE_TOKEN_PATH: path.join(dir, 'missing.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const waitFor = async (id: number) => {
    for (let i = 0; i < 800; i++) {
      if (stdout.split('\n').some((l) => l.includes(`"id":${id}`))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for response ${id}; stderr: ${stderr}`);
  };

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    },
  });
  await waitFor(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await waitFor(2);
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'gmail_send_email',
      arguments: { to: ['a@example.com'], subject: 'S', body: 'B' },
    },
  });
  await waitFor(3);
  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'gdocs_append_text', arguments: { document: 'bad', text: 'x' } },
  });
  await waitFor(4);
  send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'no_such_tool', arguments: {} },
  });
  await waitFor(5);
  child.stdin.end();
  await new Promise((r) => child.once('exit', r));
  rmSync(dir, { recursive: true, force: true });

  const lines = stdout.split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThanOrEqual(5);
  for (const line of lines) {
    const msg = JSON.parse(line);
    expect(msg.jsonrpc).toBe('2.0');
  }
  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  expect(byId[1].result.protocolVersion).toBe('2025-11-25');
  expect(byId[2].result.tools.length).toBe(4);
  expect(byId[3].result.isError).toBe(true);
  expect(byId[3].result.content[0].text).toMatch(/npx gmail-docs-mcp auth/);
  expect(byId[4].result.isError).toBe(true);
  // Logs went to stderr as JSON lines.
  expect(stderr).toMatch(/"msg":"gmail-docs-mcp listening on stdio"/);
}, 30_000);

it('exits with code 2 on invalid configuration, printing to stderr only', () => {
  let out = '';
  try {
    execFileSync(process.execPath, [entry], {
      env: { PATH: process.env.PATH ?? '', EMAIL_MAX_RECIPIENTS: 'lots' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect.unreachable();
  } catch (e) {
    const err = e as { status: number; stdout: Buffer; stderr: Buffer };
    expect(err.status).toBe(2);
    out = err.stdout.toString();
    expect(err.stderr.toString()).toMatch(/EMAIL_MAX_RECIPIENTS/);
  }
  expect(out).toBe('');
});
