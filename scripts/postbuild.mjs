// Ensures the CLI entry is executable with a node shebang after tsc.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const src = readFileSync(entry, 'utf8');
if (!src.startsWith('#!')) writeFileSync(entry, `#!/usr/bin/env node\n${src}`);
try {
  chmodSync(entry, 0o755);
} catch {
  // chmod is a no-op on Windows.
}
