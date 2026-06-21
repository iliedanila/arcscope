import { z } from 'zod';
import { writeAssertion } from '../knowledge/assertion-store.js';
import type { AssertionInput } from '../knowledge/assertion-store.js';

const locatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('symbol'), query: z.string().min(1), in: z.string().optional() }),
  z.object({ kind: z.literal('path'), glob: z.string().min(1), in: z.string().optional() }),
  z.object({ kind: z.literal('import'), of: z.string().min(1), in: z.string().optional() }),
]);

export const archAssertInputShape = {
  id: z.string().min(1).describe("kebab-case concept id, e.g. 'record-clone'."),
  title: z.string().min(1).describe('Short human-readable title for the concept.'),
  description: z.string().optional().describe('One-line description of what the concept is.'),
  locators: z
    .array(locatorSchema)
    .min(1)
    .optional()
    .describe(
      'The binding: locators that resolve to the concept members LIVE (so new matches appear automatically). ' +
        'Each is { kind: "symbol", query } | { kind: "path", glob } | { kind: "import", of }, optional "in" scope. ' +
        'Pin a known scattered member with a path locator. Omit when recording a `flow` concept.',
    ),
  flow: z
    .object({ entry: z.string().min(1), pathGlob: z.string().optional() })
    .optional()
    .describe(
      'Record a FLOW concept instead of locators: its entry-point function/method. The flow is recomputed LIVE ' +
        '(precise tier: the method-resolved call closure + edge cases) on every arch_query, with drift on its ' +
        'membership. Use after reviewing a flow with the flow tool, to persist it for a later session.',
    ),
  must: z
    .object({ title: z.string().optional(), locators: z.array(locatorSchema).min(1) })
    .optional()
    .describe(
      'Optional invariant every member file must satisfy (conformance). Members not matched by these locators are ' +
        'reported as violations on every arch_query. E.g. must import the module that re-indexes after cloning.',
    ),
};

// Record (or update) one architecture assertion into the agent-owned
// .arcscope/assertions.yaml — the write-back surface. The stored object is a
// binding + invariant, re-verified on every read (never a bare fact), so a later
// session inherits it and arcscope keeps it honest against live code.
export async function runArchAssert(root: string, args: AssertionInput): Promise<{ text: string }> {
  if (!args.flow && !(args.locators && args.locators.length > 0)) {
    return { text: `arch_assert needs either "locators" (a binding) or a "flow" entry — concept \`${args.id}\` had neither.` };
  }
  writeAssertion(root, args);
  const kind = args.flow ? `flow from \`${args.flow.entry}\`` : 'binding';
  const rule = args.must ? ` with invariant "${args.must.title ?? 'must'}"` : '';
  return {
    text:
      `Recorded \`${args.id}\` (${kind})${rule} to .arcscope/assertions.yaml. ` +
      `It is recomputed live and re-checked on every arch_query — a later session inherits it. ` +
      `Run arch_query ${args.id} to see it.`,
  };
}
