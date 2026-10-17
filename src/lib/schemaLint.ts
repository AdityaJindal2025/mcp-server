/**
 * Portability linter for tool definitions (C4, C5, C8). Runs in the contract
 * test against the real `tools/list` output.
 */

export interface LintableTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

const BANNED_KEYWORDS = [
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  '$ref',
  '$defs',
  'definitions',
  'patternProperties',
  'format',
  'pattern',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'propertyNames',
];
const SCALARS = new Set(['string', 'integer', 'number', 'boolean']);
const NAME = /^[a-z0-9_]{1,40}$/;
const HOST_WORDS = /\b(claude|chatgpt|openai|gemini|copilot|cursor)\b/i;

type Schema = Record<string, unknown>;

function isScalarSchema(s: Schema): boolean {
  return typeof s['type'] === 'string' && SCALARS.has(s['type']);
}

function checkCommon(s: Schema, where: string, errors: string[]): void {
  for (const k of BANNED_KEYWORDS) {
    if (k in s) errors.push(`${where}: uses banned keyword "${k}"`);
  }
  if (Array.isArray(s['type']))
    errors.push(`${where}: "type" must be a single string, not an array`);
  if ('additionalProperties' in s && s['additionalProperties'] !== false) {
    errors.push(`${where}: "additionalProperties" may only be false`);
  }
  if ('enum' in s) {
    const values = s['enum'];
    if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) {
      errors.push(`${where}: enums must contain only strings`);
    }
    if (s['type'] !== 'string') errors.push(`${where}: enum properties must have type "string"`);
  }
}

function checkProperty(
  s: Schema,
  where: string,
  errors: string[],
  requireDescription: boolean,
): void {
  checkCommon(s, where, errors);
  if (requireDescription && (typeof s['description'] !== 'string' || !s['description'].trim())) {
    errors.push(`${where}: missing description`);
  }
  if (isScalarSchema(s)) return;
  if (s['type'] === 'array') {
    const items = s['items'];
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      errors.push(`${where}: array must declare a single "items" schema`);
      return;
    }
    const it = items as Schema;
    checkCommon(it, `${where}[]`, errors);
    if (isScalarSchema(it)) return;
    // Arrays of string arrays are allowed (tables).
    if (it['type'] === 'array') {
      const inner = it['items'] as Schema | undefined;
      if (inner && typeof inner === 'object') checkCommon(inner, `${where}[][]`, errors);
      if (!inner || inner['type'] !== 'string') {
        errors.push(`${where}: nested arrays must be arrays of strings`);
      }
      return;
    }
    errors.push(`${where}: array items must be scalars or string arrays`);
    return;
  }
  errors.push(
    `${where}: type "${String(s['type'])}" is not portable (use string/integer/number/boolean/array)`,
  );
}

function checkObjectSchema(
  schema: Schema,
  where: string,
  errors: string[],
  requireDescriptions: boolean,
): void {
  checkCommon(schema, where, errors);
  if (schema['type'] !== 'object') errors.push(`${where}: top level must be type "object"`);
  const props = (schema['properties'] ?? {}) as Record<string, Schema>;
  for (const [name, prop] of Object.entries(props)) {
    // Output objects may nest objects in arrays (e.g. tabs); validate them recursively.
    if (
      !requireDescriptions &&
      prop['type'] === 'array' &&
      (prop['items'] as Schema)?.['type'] === 'object'
    ) {
      checkCommon(prop, `${where}.${name}`, errors);
      checkObjectSchema(prop['items'] as Schema, `${where}.${name}[]`, errors, false);
      continue;
    }
    checkProperty(prop, `${where}.${name}`, errors, requireDescriptions);
  }
}

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0).length;
}

export function lintTools(tools: LintableTool[], serverLabel = 'gmail_docs'): string[] {
  const errors: string[] = [];
  for (const tool of tools) {
    const t = tool.name;
    if (!NAME.test(t)) errors.push(`${t}: name must match ${NAME}`);
    if (!/^(gmail|gdocs)_/.test(t))
      errors.push(`${t}: name must be prefixed with gmail_ or gdocs_`);
    if (`${serverLabel}_${t}`.length > 64) {
      errors.push(`${t}: "${serverLabel}_${t}" exceeds 64 characters`);
    }
    const desc = tool.description ?? '';
    if (!desc.trim()) errors.push(`${t}: missing description`);
    else {
      const n = sentenceCount(desc);
      if (n < 1 || n > 4) errors.push(`${t}: description should be 1-3 sentences (found ${n})`);
      if (HOST_WORDS.test(desc)) errors.push(`${t}: description mentions a specific host`);
    }
    checkObjectSchema(tool.inputSchema, `${t}.input`, errors, true);
    if (tool.outputSchema) checkObjectSchema(tool.outputSchema, `${t}.output`, errors, false);
  }
  return errors;
}
