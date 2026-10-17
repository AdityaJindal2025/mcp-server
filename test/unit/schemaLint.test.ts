import { describe, expect, it } from 'vitest';
import { lintTools, type LintableTool } from '../../src/lib/schemaLint.js';

const good: LintableTool = {
  name: 'gmail_send_email',
  description: 'Send an email. It cannot be undone.',
  inputSchema: {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      to: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Recipients.' },
      n: { type: 'integer', minimum: 0, description: 'Count.' },
      fmt: { type: 'string', enum: ['a', 'b'], description: 'Format.' },
      rows: {
        type: 'array',
        items: { type: 'array', items: { type: 'string' } },
        description: 'Rows.',
      },
    },
    required: ['to'],
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      tabs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { tab_id: { type: 'string' } },
        },
      },
    },
  },
};

const withProp = (prop: Record<string, unknown>): LintableTool => ({
  ...good,
  inputSchema: { type: 'object', properties: { p: { description: 'P.', ...prop } } },
});

describe('lintTools', () => {
  it('accepts a portable tool', () => {
    expect(lintTools([good])).toEqual([]);
  });

  it.each([
    [{ type: 'string', format: 'email' }, /banned keyword "format"/],
    [{ type: 'string', pattern: '^a' }, /banned keyword "pattern"/],
    [{ anyOf: [{ type: 'string' }] }, /banned keyword "anyOf"/],
    [{ oneOf: [] }, /banned keyword "oneOf"/],
    [{ $ref: '#/x' }, /banned keyword "\$ref"/],
    [{ type: ['string', 'null'] }, /single string/],
    [{ type: 'object', additionalProperties: { type: 'string' } }, /additionalProperties/],
    [{ type: 'object' }, /not portable/],
    [{ type: 'integer', enum: [1, 2] }, /enums must contain only strings/],
    [{ type: 'array', items: { type: 'object' } }, /scalars or string arrays/],
    [{ type: 'array', items: { type: 'array', items: { type: 'integer' } } }, /arrays of strings/],
    [{ type: 'array' }, /single "items"/],
    [{ type: 'string', description: '' }, /missing description/],
  ])('rejects %j', (prop, msg) => {
    expect(lintTools([withProp(prop)]).join('\n')).toMatch(msg);
  });

  it('checks names, prefixes and descriptions', () => {
    const errs = lintTools([
      { ...good, name: 'SendEmail' },
      { ...good, name: 'docs_x' },
      { ...good, name: 'gmail_' + 'x'.repeat(50) },
      { ...good, description: '' },
      { ...good, description: 'Claude should send this.' },
      { ...good, description: 'One. Two. Three. Four. Five.' },
      { ...good, inputSchema: { type: 'array' } },
    ]).join('\n');
    expect(errs).toMatch(/SendEmail: name must match/);
    expect(errs).toMatch(/docs_x: name must be prefixed/);
    expect(errs).toMatch(/exceeds 64 characters/);
    expect(errs).toMatch(/missing description/);
    expect(errs).toMatch(/mentions a specific host/);
    expect(errs).toMatch(/1-3 sentences/);
    expect(errs).toMatch(/top level must be type "object"/);
  });
});
