import * as z from 'zod';
import { SCOPES } from '../../config.js';
import { mapGoogleError } from '../../lib/errors.js';
import { retryableSend, withRetry } from '../../lib/retry.js';
import type { ToolDefinition } from '../../lib/tool.js';
import { composeEmail, emailFields, recipientSummary } from './compose.js';

const input = z.object(emailFields);

const output = z
  .object({
    draft_id: z.string(),
    message_id: z.string(),
  })
  .strict();

/** P1, opt-in (ENABLE_DRAFTS=true): requires the restricted gmail.compose scope. */
export const createDraftTool: ToolDefinition<typeof input, typeof output> = {
  name: 'gmail_create_draft',
  title: 'Create email draft',
  description:
    'Create a draft email in the connected Gmail account without sending it, so the user can review and send it themselves. Use this instead of gmail_send_email when the user wants to review first.',
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
    const { config, google, audit } = ctx;
    // Drafts don't count against EMAIL_MAX_PER_HOUR (nothing is sent), but the allowlist still applies.
    const email = composeEmail(args, config);
    const auditBase = {
      tool: 'gmail_create_draft' as const,
      transport: ctx.transport,
      ...email.auditFields,
      ...(args.client_request_id && { client_request_id: args.client_request_id }),
    };
    await google.ensureScopes([SCOPES.gmailCompose]);
    let draft;
    try {
      const gmail = await google.gmail();
      const res = await withRetry(
        () =>
          gmail.users.drafts.create(
            { userId: 'me', requestBody: { message: { raw: email.raw } } },
            google.requestOptions,
          ),
        { retryOn: retryableSend },
      );
      draft = res.data;
    } catch (err) {
      const accountEmail = await google.accountEmail();
      const mapped = mapGoogleError(err, { api: 'Gmail', ...(accountEmail && { accountEmail }) });
      await audit.write({ ...auditBase, status: 'error', error_code: mapped.code });
      throw mapped;
    }
    const draftId = draft.id ?? '';
    const messageId = draft.message?.id ?? '';
    await audit.write({ ...auditBase, status: 'ok', draft_id: draftId, message_id: messageId });
    return {
      text: `Draft created for ${recipientSummary(email.recipients)} (subject: "${email.subject}"). It has NOT been sent; review it at https://mail.google.com/mail/#drafts. Draft id: ${draftId}`,
      structured: { draft_id: draftId, message_id: messageId },
    };
  },
};
