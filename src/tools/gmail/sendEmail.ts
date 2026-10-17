import * as z from 'zod';
import { SCOPES } from '../../config.js';
import { mapGoogleError, ToolError } from '../../lib/errors.js';
import { retryableSend, withRetry } from '../../lib/retry.js';
import type { ToolDefinition } from '../../lib/tool.js';
import { composeEmail, emailFields, previewEmail, recipientSummary } from './compose.js';

const input = z.object({
  ...emailFields,
  dry_run: z
    .boolean()
    .optional()
    .describe('If true, validate and return the composed email without sending. Default false.'),
});

const output = z
  .object({
    status: z.enum(['sent', 'dry_run']),
    message_id: z.string(),
    thread_id: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc_count: z.number().int(),
    subject: z.string(),
  })
  .strict();

export const sendEmailTool: ToolDefinition<typeof input, typeof output> = {
  name: 'gmail_send_email',
  title: 'Send email',
  description:
    'Send an email from the connected Gmail account. This sends immediately and cannot be undone. If the user has not clearly stated the recipients and content, confirm with them first. Set dry_run to true to preview without sending.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input,
  output,
  idempotent: true,
  async handler(args, ctx) {
    const { config, google, limiter, audit } = ctx;
    const email = composeEmail(args, config);
    const forced = config.email.dryRun;
    const base = {
      to: email.recipients.to,
      cc: email.recipients.cc,
      bcc_count: email.recipients.bcc.length,
      subject: email.subject,
    };
    const auditBase = {
      tool: 'gmail_send_email' as const,
      transport: ctx.transport,
      ...email.auditFields,
      ...(args.client_request_id && { client_request_id: args.client_request_id }),
    };

    if (args.dry_run || forced) {
      await audit.write({ ...auditBase, status: 'dry_run' });
      const why = forced ? ' (The server is in EMAIL_DRY_RUN mode.)' : '';
      return {
        text: `Dry run: email to ${recipientSummary(email.recipients)} (subject: "${email.subject}") was NOT sent.${why}\n\n${previewEmail(email, args.body)}`,
        structured: { status: 'dry_run', message_id: '', thread_id: '', ...base },
      };
    }

    await google.ensureScopes([SCOPES.gmailSend]);
    const reservation = limiter.reserve();
    let sent: { id?: string | null; threadId?: string | null };
    try {
      const gmail = await google.gmail();
      const res = await withRetry(
        () =>
          gmail.users.messages.send(
            { userId: 'me', requestBody: { raw: email.raw } },
            google.requestOptions,
          ),
        {
          retryOn: retryableSend,
          onRetry: (_e, attempt, delayMs) =>
            ctx.logger.warn('retrying gmail send', { attempt, delayMs }),
        },
      );
      sent = res.data;
      reservation.commit();
    } catch (err) {
      reservation.release();
      const mapped = mapGoogleError(err, {
        api: 'Gmail',
        sending: true,
        ...(await google.accountEmail().then((e) => (e ? { accountEmail: e } : {}))),
      });
      if (!(err instanceof ToolError)) {
        await audit.write({ ...auditBase, status: 'error', error_code: mapped.code });
      }
      throw mapped;
    }

    const messageId = sent.id ?? '';
    const threadId = sent.threadId ?? '';
    await audit.write({ ...auditBase, status: 'ok', message_id: messageId, thread_id: threadId });
    return {
      text: `Email sent to ${recipientSummary(email.recipients)} (subject: "${email.subject}"). Gmail message id: ${messageId}`,
      structured: { status: 'sent', message_id: messageId, thread_id: threadId, ...base },
    };
  },
};
