import * as z from 'zod';
import type { Config } from '../../config.js';
import { sha256 } from '../../lib/audit.js';
import {
  checkAllowedDomains,
  checkBody,
  checkRecipientCount,
  checkSubject,
  normalizeAddress,
  normalizeRecipients,
  type Recipients,
} from '../../lib/guards.js';
import { buildMime, htmlToPlainText, toBase64Url } from '../../lib/mime.js';

export const CLIENT_REQUEST_ID_DESCRIPTION =
  'Optional unique ID for this request (max 128 characters). If the same ID is sent again within 24 hours, the original result is returned instead of repeating the action.';

/** Input fields shared by gmail_send_email and gmail_create_draft (PS §6.2, §6.6). */
export const emailFields = {
  to: z
    .array(z.string())
    .min(1)
    .describe('Recipient email addresses, e.g. ["alex@example.com"]. At least one.'),
  cc: z.array(z.string()).optional().describe('Optional CC addresses.'),
  bcc: z.array(z.string()).optional().describe('Optional BCC addresses.'),
  subject: z.string().describe('Subject line, plain text, max 250 characters.'),
  body: z.string().describe("Email body. Plain text unless body_format is 'html'."),
  body_format: z.enum(['text', 'html']).optional().describe("Format of body. Default 'text'."),
  client_request_id: z.string().max(128).optional().describe(CLIENT_REQUEST_ID_DESCRIPTION),
};

export interface EmailArgs {
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  body: string;
  body_format?: 'text' | 'html' | undefined;
}

export interface ComposedEmail {
  recipients: Recipients;
  subject: string;
  format: 'text' | 'html';
  raw: string;
  mime: string;
  auditFields: {
    to: string[];
    cc: string[];
    bcc_count: number;
    subject_sha256: string;
    body_len: number;
    body_sha256: string;
  };
}

/** Validates (guards in PS §6.2/§9 order) and builds the MIME message. */
export function composeEmail(args: EmailArgs, config: Config): ComposedEmail {
  const recipients = normalizeRecipients(args.to, args.cc ?? [], args.bcc ?? []);
  checkRecipientCount(recipients, config.email.maxRecipients);
  checkAllowedDomains(recipients, config.email.allowedDomains);
  const subject = checkSubject(args.subject);
  checkBody(args.body);
  const format = args.body_format ?? 'text';
  const from = config.email.sendAs ? normalizeAddress(config.email.sendAs) : undefined;
  const mime = buildMime({
    ...(from && { from }),
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    subject,
    body: args.body,
    format,
  });
  return {
    recipients,
    subject,
    format,
    mime,
    raw: toBase64Url(mime),
    auditFields: {
      to: recipients.to,
      cc: recipients.cc,
      bcc_count: recipients.bcc.length,
      subject_sha256: sha256(subject),
      body_len: args.body.length,
      body_sha256: sha256(args.body),
    },
  };
}

const PREVIEW_CHARS = 4000;

/** Human-readable preview of a composed email for dry runs (D2: text content only). */
export function previewEmail(email: ComposedEmail, body: string): string {
  const r = email.recipients;
  const text = email.format === 'html' ? htmlToPlainText(body) : body;
  const clipped =
    text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}… [preview truncated]` : text;
  return [
    `To: ${r.to.join(', ')}`,
    ...(r.cc.length ? [`Cc: ${r.cc.join(', ')}`] : []),
    ...(r.bcc.length ? [`Bcc: ${r.bcc.length} recipient(s)`] : []),
    `Subject: ${email.subject}`,
    `Format: ${email.format}`,
    '',
    clipped,
  ].join('\n');
}

export function recipientSummary(r: Recipients): string {
  const shown = [...r.to, ...r.cc];
  const list =
    shown.length > 5
      ? `${shown.slice(0, 5).join(', ')} and ${shown.length - 5} more`
      : shown.join(', ');
  return r.bcc.length ? `${list} (+${r.bcc.length} bcc)` : list;
}
