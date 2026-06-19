// stderr-ONLY logging. This is the single chokepoint that enforces stdio hygiene:
// arcscope speaks JSON-RPC on stdout, and a stray write to stdout corrupts that
// stream and silently hangs the server. Never use console.log anywhere; log here.

export function log(...args: unknown[]): void {
  console.error('[arcscope]', ...args);
}

export function logError(...args: unknown[]): void {
  console.error('[arcscope:error]', ...args);
}
