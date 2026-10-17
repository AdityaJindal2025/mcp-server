import { randomBytes } from 'node:crypto';
import { convert } from 'html-to-text';

const CRLF = '\r\n';
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
/** Max UTF-8 bytes per RFC 2047 encoded word: 45 bytes -> 60 base64 chars, + 12 = 72 <= 75. */
const MAX_WORD_BYTES = 45;

/**
 * RFC 2047-encodes a header value when it isn't plain ASCII, splitting into
 * encoded words that never break a UTF-8 sequence or surrogate pair.
 */
export function encodeHeaderValue(value: string): string {
  if (PRINTABLE_ASCII.test(value)) return value;
  const words: string[] = [];
  let chunk: Buffer[] = [];
  let size = 0;
  for (const ch of value) {
    const bytes = Buffer.from(ch, 'utf8');
    if (size + bytes.length > MAX_WORD_BYTES && chunk.length > 0) {
      words.push(Buffer.concat(chunk).toString('base64'));
      chunk = [];
      size = 0;
    }
    chunk.push(bytes);
    size += bytes.length;
  }
  if (chunk.length > 0) words.push(Buffer.concat(chunk).toString('base64'));
  return words.map((w) => `=?UTF-8?B?${w}?=`).join(`${CRLF} `);
}

/** Folds a plain-ASCII header at spaces so lines stay within 78 characters. */
export function foldAscii(name: string, value: string): string {
  const out: string[] = [];
  let line = `${name}:`;
  for (const word of value.split(' ')) {
    if (line.length + 1 + word.length > 78 && line.length > name.length + 1) {
      out.push(line);
      line = ` ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  out.push(line);
  return out.join(CRLF);
}

function header(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`Header ${name} contains a line break`);
  const encoded = encodeHeaderValue(value);
  return encoded === value ? foldAscii(name, value) : `${name}: ${encoded}`;
}

function addressHeader(name: string, addresses: string[]): string {
  const lines: string[] = [];
  let line = `${name}: `;
  addresses.forEach((addr, i) => {
    const piece = addr + (i < addresses.length - 1 ? ',' : '');
    if (line.length + piece.length > 78 && line.trim() !== `${name}:`) {
      lines.push(line.trimEnd());
      line = ` ${piece} `;
    } else {
      line += `${piece} `;
    }
  });
  lines.push(line.trimEnd());
  return lines.join(CRLF);
}

function base64Body(text: string): string {
  const b64 = Buffer.from(text.replace(/\r?\n/g, CRLF), 'utf8').toString('base64');
  return (b64.match(/.{1,76}/g) ?? ['']).join(CRLF);
}

function rfc2822Date(d: Date): string {
  return d.toUTCString().replace('GMT', '+0000');
}

export function htmlToPlainText(html: string): string {
  return convert(html, { wordwrap: 100 });
}

export interface MimeInput {
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  format: 'text' | 'html';
  date?: Date;
  boundary?: string;
}

/** Builds an RFC 2822 message with CRLF line endings (PS §6.2). */
export function buildMime(input: MimeInput): string {
  const headers: string[] = ['MIME-Version: 1.0', `Date: ${rfc2822Date(input.date ?? new Date())}`];
  if (input.from) headers.push(header('From', input.from));
  headers.push(addressHeader('To', input.to));
  if (input.cc.length > 0) headers.push(addressHeader('Cc', input.cc));
  // Gmail removes Bcc from delivered copies; it must be present for Gmail to deliver to them.
  if (input.bcc.length > 0) headers.push(addressHeader('Bcc', input.bcc));
  headers.push(header('Subject', input.subject));

  if (input.format === 'text') {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join(CRLF)}${CRLF}${CRLF}${base64Body(input.body)}${CRLF}`;
  }

  const boundary = input.boundary ?? `=_gdm_${randomBytes(12).toString('hex')}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type: string, content: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=UTF-8`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(content),
    ].join(CRLF);
  return [
    headers.join(CRLF),
    '',
    part('text/plain', htmlToPlainText(input.body)),
    part('text/html', input.body),
    `--${boundary}--`,
    '',
  ].join(CRLF);
}

export function toBase64Url(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url');
}
