import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from './logger.js';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface AuditBase {
  transport: 'stdio' | 'http';
  status: 'ok' | 'dry_run' | 'error' | 'cached';
  error_code?: string;
  client_request_id?: string;
}

/**
 * Closed set of audit shapes. Bodies, appended text and tokens have no field
 * here, so they can't be logged by accident; only lengths and SHA-256 hashes.
 */
export type AuditEvent =
  | (AuditBase & {
      tool: 'gmail_send_email' | 'gmail_create_draft';
      to: string[];
      cc: string[];
      bcc_count: number;
      subject_sha256: string;
      body_len: number;
      body_sha256: string;
      message_id?: string;
      thread_id?: string;
      draft_id?: string;
    })
  | (AuditBase & {
      tool: 'gdocs_append_text' | 'gdocs_append_table';
      doc_id: string;
      tab_id?: string;
      revision_id?: string;
      inserted_chars?: number;
      text_sha256?: string;
      row_count?: number;
      column_count?: number;
    });

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

const stamp = (event: AuditEvent) => ({ ts: new Date().toISOString(), type: 'audit', ...event });

/** Default sink: one JSON line on stderr via the logger (never filtered by LOG_LEVEL). */
export class StderrAudit implements AuditSink {
  constructor(private readonly logger: Logger) {}
  async write(event: AuditEvent): Promise<void> {
    this.logger.record(stamp(event));
  }
}

/** Appends JSONL to AUDIT_LOG_PATH (file created 0600). Writes are serialized. */
export class FileAudit implements AuditSink {
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void> | undefined;

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {}

  write(event: AuditEvent): Promise<void> {
    const line = `${JSON.stringify(stamp(event))}\n`;
    this.ready ??= fs.mkdir(path.dirname(this.file), { recursive: true }).then(() => undefined);
    this.queue = this.queue
      .then(() => this.ready)
      .then(() => fs.appendFile(this.file, line, { mode: 0o600 }))
      .catch((err: unknown) => {
        this.logger.error('audit write failed', { error: err, file: this.file });
      });
    return this.queue;
  }
}

export class MemoryAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
