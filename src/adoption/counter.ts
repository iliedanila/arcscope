import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logError } from '../log.js';

// Local-only invocation counter for the adoption gate. Appends one JSONL line per
// tool call to .arcscope/usage.jsonl so the grep-vs-tool ratio can be inspected
// during dogfooding. NEVER touches the network. Fire-and-forget: a failed write
// is logged to stderr and swallowed — instrumentation must never break the tool.
export class InvocationCounter {
  constructor(private readonly file: string) {}

  async record(tool: string, args: unknown): Promise<void> {
    const line = JSON.stringify({ ts: new Date().toISOString(), tool, args }) + '\n';
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, line, 'utf8');
    } catch (err) {
      logError('usage counter write failed (non-fatal):', err);
    }
  }
}
