import { ToolError } from './errors.js';

const CRLF = /[\r\n\0]/;
// Pragmatic address check (D7). Bare addresses only; IDN domains must be punycode.
const ADDRESS =
  /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export const MAX_SUBJECT_CHARS = 250;
/** Gmail accepts ~35 MB raw messages; bodies this large are almost certainly a mistake. */
export const MAX_BODY_CHARS = 1_000_000;

/** Validates one address and returns it with a lowercased domain part. */
export function normalizeAddress(input: string): string {
  if (CRLF.test(input)) {
    throw new ToolError(
      'INVALID_ADDRESS',
      'Email addresses must not contain line breaks. Nothing was sent.',
    );
  }
  const addr = input.trim();
  if (/[<>]/.test(addr) || /\s/.test(addr)) {
    throw new ToolError(
      'INVALID_ADDRESS',
      `"${addr}" is not a bare email address. Pass only the address, like alex@example.com, without a display name.`,
    );
  }
  if (/[,;]/.test(addr)) {
    throw new ToolError(
      'INVALID_ADDRESS',
      `"${addr}" contains more than one address. Put each address in its own array item.`,
    );
  }
  if (addr.length > 254 || !ADDRESS.test(addr)) {
    throw new ToolError(
      'INVALID_ADDRESS',
      `"${addr}" is not a valid email address. Use a bare address like alex@example.com.`,
    );
  }
  const at = addr.lastIndexOf('@');
  return `${addr.slice(0, at)}@${addr.slice(at + 1).toLowerCase()}`;
}

export interface Recipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

/**
 * Validates and de-duplicates (case-insensitively) across to/cc/bcc, keeping
 * the first occurrence with precedence to > cc > bcc.
 */
export function normalizeRecipients(
  to: string[],
  cc: string[] = [],
  bcc: string[] = [],
): Recipients {
  const seen = new Set<string>();
  const pick = (list: string[]) => {
    const out: string[] = [];
    for (const raw of list) {
      const addr = normalizeAddress(raw);
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(addr);
    }
    return out;
  };
  const result = { to: pick(to), cc: pick(cc), bcc: pick(bcc) };
  if (result.to.length === 0) {
    throw new ToolError('INVALID_ADDRESS', 'At least one "to" recipient is required.');
  }
  return result;
}

export function allRecipients(r: Recipients): string[] {
  return [...r.to, ...r.cc, ...r.bcc];
}

export function checkRecipientCount(r: Recipients, max: number): void {
  const total = allRecipients(r).length;
  if (total > max) {
    throw new ToolError(
      'TOO_MANY_RECIPIENTS',
      `Too many recipients (${total}). The limit is ${max}. Nothing was sent.`,
    );
  }
}

/**
 * `example.com` matches exactly; `.example.com` matches any subdomain of
 * example.com. An empty allowlist allows every domain.
 */
export function isDomainAllowed(address: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  return allowed.some((entry) =>
    entry.startsWith('.')
      ? domain.endsWith(entry) && domain.length > entry.length
      : domain === entry,
  );
}

export function checkAllowedDomains(r: Recipients, allowed: string[]): void {
  const blocked = allRecipients(r).filter((a) => !isDomainAllowed(a, allowed));
  if (blocked.length > 0) {
    throw new ToolError(
      'RECIPIENT_NOT_ALLOWED',
      `Blocked recipient(s): ${blocked.join(', ')}. This server only sends to: ${allowed.join(', ')}. Nothing was sent.`,
    );
  }
}

export function checkSubject(subject: string): string {
  if (CRLF.test(subject)) {
    throw new ToolError(
      'INVALID_SUBJECT',
      'Subject must be a single line (no line breaks). Nothing was sent.',
    );
  }
  if ([...subject].length > MAX_SUBJECT_CHARS) {
    throw new ToolError(
      'INVALID_SUBJECT',
      `Subject is longer than ${MAX_SUBJECT_CHARS} characters. Shorten it and retry.`,
    );
  }
  return subject;
}

export function checkBody(body: string): void {
  if (body.length > MAX_BODY_CHARS) {
    throw new ToolError(
      'TOO_LARGE',
      `Email body is ${body.length.toLocaleString('en-US')} characters; the limit is ${MAX_BODY_CHARS.toLocaleString('en-US')}.`,
    );
  }
}

export function checkAppendSize(chars: number, max: number, what = 'Text'): void {
  if (chars > max) {
    throw new ToolError(
      'TOO_LARGE',
      `${what} is ${chars.toLocaleString('en-US')} characters; the limit is ${max.toLocaleString('en-US')}. Split it into smaller appends.`,
    );
  }
}

export function checkDocAllowed(documentId: string, allowedIds: string[]): void {
  if (allowedIds.length > 0 && !allowedIds.includes(documentId)) {
    throw new ToolError(
      'DOC_NOT_ALLOWED',
      `This server is not allowed to access document ${documentId}.`,
    );
  }
}
