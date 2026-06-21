import { z } from 'zod';
import type { IndexStore } from '../engine/index-store.js';
import { loadKnowledge } from '../knowledge/vocab-loader.js';
import { resolveConceptSafe, resolveLocators } from '../knowledge/resolver.js';
import { referencesForConcept, findReimplementations } from '../knowledge/candidates.js';
import type { CandidateMatch } from '../knowledge/candidates.js';

export const archCandidatesInputShape = {
  concept: z.string().min(1).describe('Concept id (from arch_list) whose implementation to find re-implementations of.'),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum structural similarity, 0..1 (default 0.75). Lower = more (and noisier) candidates.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max candidates to return (default 10).'),
};

export interface ArchCandidatesResult {
  candidates: CandidateMatch[];
  text: string;
}

// Find likely UNPINNED members of a concept: functions elsewhere that structurally
// resemble its implementation (name-independent AST-shape match), so the agent can
// confirm and pin the real ones via arch_assert. Suspects, not members — the
// 'structural-similarity' tier is heuristic by construction.
export async function runArchCandidates(
  store: IndexStore,
  root: string,
  args: { concept: string; threshold?: number; limit?: number },
): Promise<ArchCandidatesResult> {
  await store.sync();
  const vocab = loadKnowledge(root);
  const concept = vocab.concepts.find((c) => c.id === args.concept);
  if (!concept) {
    const known = vocab.concepts.length ? ` Known concepts: ${vocab.concepts.map((c) => c.id).join(', ')}.` : '';
    return { candidates: [], text: `No concept "${args.concept}" in the vocabulary.${known}` };
  }

  const { locations, error } = resolveConceptSafe(store, concept);
  if (error) return { candidates: [], text: `Concept "${concept.id}" has an invalid locator: ${error}` };

  const memberFiles = [...new Set(locations.map((l) => l.file))];
  const allFps = store.allFingerprints();
  const { references, referenceFiles } = referencesForConcept(store, concept, memberFiles, allFps);
  if (references.length === 0) {
    return {
      candidates: [],
      text: `Concept "${concept.id}" has no fingerprintable implementation to compare against (its members are too small or define no functions). Nothing to search for re-implementations of.`,
    };
  }

  const threshold = args.threshold ?? 0.75;
  const candidates = findReimplementations(allFps, references, { exclude: referenceFiles, threshold, limit: args.limit ?? 10 });

  // The invariant cross-check is a best-effort adornment — a malformed `must`
  // locator must not crash the whole tool (mirrors how concept locators degrade).
  let satisfying: Set<string> | undefined;
  if (concept.must) {
    try {
      satisfying = new Set(resolveLocators(store, concept.must.locators).map((r) => r.file));
    } catch {
      satisfying = undefined;
    }
  }

  return { candidates, text: formatCandidates(concept.id, candidates, references.length, threshold, concept.must?.title, satisfying) };
}

function formatCandidates(
  conceptId: string,
  candidates: CandidateMatch[],
  refCount: number,
  threshold: number,
  invariantTitle: string | undefined,
  satisfying: Set<string> | undefined,
): string {
  const footer = `(structural-similarity tier — AST shape, name-independent; threshold ${threshold}, vs ${refCount} reference function${refCount === 1 ? '' : 's'} from the concept's implementation)`;
  if (candidates.length === 0) {
    return `Concept \`${conceptId}\` — no structural re-implementations found above ${threshold}. The binding may already cover them, or none exist.\n${footer}`;
  }
  const head = `Concept \`${conceptId}\` — ${candidates.length} structural candidate${candidates.length === 1 ? '' : 's'} (SUSPECTS, not members — confirm and pin with arch_assert if real):`;
  const lines = candidates.map((c) => {
    const violates = satisfying && !satisfying.has(c.file);
    const flag = violates ? `  ⚠ would VIOLATE invariant${invariantTitle ? ` (${invariantTitle})` : ''}` : '';
    return `  ${c.file}:${c.line}  ${c.name}  [${c.score} ~ ${c.resembles}]${flag}`;
  });
  return [head, ...lines, footer].join('\n');
}
