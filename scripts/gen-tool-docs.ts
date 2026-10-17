/**
 * Regenerates the "Tool reference" section of README.md from the live
 * tools/list output, so the docs can't drift from the contract.
 *   npm run docs:tools
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../src/config.js';
import { MemoryAudit } from '../src/lib/audit.js';
import { createDeps, createServerFactory } from '../src/server.js';

type Schema = { properties?: Record<string, Record<string, unknown>>; required?: string[] };

const START = '<!-- tools:start -->';
const END = '<!-- tools:end -->';

function typeOf(p: Record<string, unknown>): string {
  if (Array.isArray(p['enum']))
    return (p['enum'] as string[]).map((v) => `\`"${v}"\``).join(' \\| ');
  if (p['type'] === 'array') {
    const items = p['items'] as Record<string, unknown>;
    return items['type'] === 'array' ? 'string[][]' : `${String(items['type'])}[]`;
  }
  return String(p['type']);
}

async function main() {
  const deps = createDeps(
    loadConfig({ ENABLE_DRAFTS: 'true', GOOGLE_TOKEN_PATH: '/nonexistent' }),
    { audit: new MemoryAudit() },
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(createServerFactory(deps, 'stdio'), { transport: st });
  const client = new Client({ name: 'docs', version: '1' });
  await client.connect(ct);
  const { tools } = await client.listTools();
  await client.close();
  await handle.close();

  const out: string[] = [START, ''];
  for (const t of tools) {
    const input = t.inputSchema as Schema;
    const output = t.outputSchema as Schema | undefined;
    const ann = t.annotations ?? {};
    out.push(`### \`${t.name}\``, '', t.description ?? '', '');
    out.push(
      `Annotations: \`readOnlyHint: ${ann.readOnlyHint}\`, \`destructiveHint: ${ann.destructiveHint}\`, \`idempotentHint: ${ann.idempotentHint}\`, \`openWorldHint: ${ann.openWorldHint}\`.`,
      '',
    );
    if (t.name === 'gmail_create_draft') out.push('Registered only when `ENABLE_DRAFTS=true`.', '');
    out.push('| Input | Type | Required | Description |', '|---|---|---|---|');
    for (const [name, p] of Object.entries(input.properties ?? {})) {
      const req = input.required?.includes(name) ? 'yes' : '';
      out.push(
        `| \`${name}\` | ${typeOf(p)} | ${req} | ${String(p['description'] ?? '').replace(/\|/g, '\\|')} |`,
      );
    }
    if (output?.properties) {
      out.push(
        '',
        `Output (\`structuredContent\`): ${Object.keys(output.properties)
          .map((k) => `\`${k}\``)
          .join(', ')}.`,
      );
    }
    out.push('');
  }
  out.push(END);

  const readme = readFileSync('README.md', 'utf8');
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < 0)
    throw new Error('README.md is missing the tools:start/tools:end markers');
  writeFileSync(
    'README.md',
    readme.slice(0, start) + out.join('\n') + readme.slice(end + END.length),
  );
  console.error(`Updated tool reference for ${tools.length} tools.`);
}

void main();
