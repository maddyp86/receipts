import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// ===========================================================================
// Demand capture for uncached senators (ADR-004, docs/adr/README.md).
//
// An unanswered query is not a failure — it is the signal that tells us where to
// spend analysis budget next. So it is recorded rather than discarded.
//
// MVP scope is deliberately a local append-only log: no queue infrastructure, no
// email capture, no orchestrator trigger. When this graduates, the same
// interface points at Supabase and the n8n per-senator orchestrator run.
// ===========================================================================

export interface QueueRequest {
  politician_id: string;
  senator_name: string;
  promise_text: string;
  requested_at: string;
}

export interface QueueStore {
  record(request: QueueRequest): Promise<void>;
}

export class FileQueueStore implements QueueStore {
  constructor(private readonly path = resolve(process.cwd(), '.data/queue.log')) {}

  async record(request: QueueRequest): Promise<void> {
    const line = JSON.stringify(request);
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${line}\n`, 'utf8');
    } catch (err) {
      // Losing a demand signal must never break the user's query — they still
      // get the honest uncached state. Log loudly and carry on.
      console.warn('[queue] could not persist request:', err);
    }
    console.info('[queue]', line);
  }
}

export const queueStore: QueueStore = new FileQueueStore();
