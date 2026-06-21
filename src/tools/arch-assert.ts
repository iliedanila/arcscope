import { z } from 'zod';
import { writeAssertion } from '../knowledge/assertion-store.js';
import type { AssertionInput } from '../knowledge/assertion-store.js';

const locatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('symbol'), query: z.string().min(1), in: z.string().optional() }),
  z.object({ kind: z.literal('path'), glob: z.string().min(1), in: z.string().optional() }),
  z.object({ kind: z.literal('import'), of: z.string().min(1), in: z.string().optional() }),
]);

export const archAssertInputShape = {
  id: z.string().min(1).describe("kebab-case concept id, e.g. 'document-copy'."),
  title: z.string().min(1).describe('Short human-readable title for the concept.'),
  description: z.string().optional().describe('One-line description of what the concept is.'),
  locators: z
    .array(locatorSchema)
    .min(1)
    .describe(
      'The binding: locators that resolve to the concept members LIVE (so new matches appear automatically). ' +
        'Each is { kind: "symbol", query } | { kind: "path", glob } | { kind: "import", of }, optional "in" scope. ' +
        'Pin a known scattered member with a path locator.',
    ),
  must: z
    .object({ title: z.string().optional(), locators: z.array(locatorSchema).min(1) })
    .optional()
    .describe(
      'Optional invariant every member file must satisfy (conformance). Members not matched by these locators are ' +
        'reported as violations on every arch_query. E.g. must import the module that re-numbers badges.',
    ),
};

// Record (or update) one architecture assertion into the agent-owned
// .arcscope/assertions.yaml — the write-back surface. The stored object is a
// binding + invariant, re-verified on every read (never a bare fact), so a later
// session inherits it and arcscope keeps it honest against live code.
export async function runArchAssert(root: string, args: AssertionInput): Promise<{ text: string }> {
  writeAssertion(root, args);
  const rule = args.must ? ` with invariant "${args.must.title ?? 'must'}"` : '';
  return {
    text:
      `Recorded assertion \`${args.id}\`${rule} to .arcscope/assertions.yaml. ` +
      `It resolves live and is re-checked on every arch_query — a later session inherits it. ` +
      `Run arch_query ${args.id} to see its current members and conformance.`,
  };
}
