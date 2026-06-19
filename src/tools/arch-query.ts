import { join } from 'node:path';
import { z } from 'zod';
import type { IndexStore } from '../engine/index-store.js';
import { loadVocabulary } from '../knowledge/vocab-loader.js';
import { resolveConceptSafe } from '../knowledge/resolver.js';
import { computeAnchors, compareDrift, loadAnchorStore, baselineFor, captureBaseline } from '../knowledge/drift.js';
import type { DriftReport } from '../knowledge/drift.js';
import type { Concept, ResolvedLocation } from '../knowledge/types.js';

export const archQueryInputShape = {
  concept: z.string().min(1).describe("Concept id from arch_list, e.g. 'repository-tokens' or 'editor-state-flow'."),
  reaccept: z
    .boolean()
    .optional()
    .describe('Re-snapshot the drift baseline to the current resolution (use after a legitimate change that the concept should now treat as correct).'),
};

export interface ArchQueryResult {
  resolved: ResolvedLocation[];
  freshness: string;
  drift?: DriftReport;
  text: string;
}

// Resolve one named concept LIVE against the current tree — never cached prose.
// (Drift detection is layered on in Slice 2.)
export async function runArchQuery(
  store: IndexStore,
  root: string,
  args: { concept: string; reaccept?: boolean },
): Promise<ArchQueryResult> {
  await store.sync();
  const vocab = loadVocabulary(join(root, '.arcscope', 'vocab.yaml'));
  const concept = vocab.concepts.find((c) => c.id === args.concept);
  if (!concept) {
    const known = vocab.concepts.length
      ? ` Known concepts: ${vocab.concepts.map((c) => c.id).join(', ')}.`
      : ' (.arcscope/vocab.yaml is missing or empty.)';
    return { resolved: [], freshness: 'unknown', text: `No concept "${args.concept}" in the vocabulary.${known}` };
  }

  const { locations: resolved, error } = resolveConceptSafe(store, concept);
  if (error) {
    return {
      resolved: [],
      freshness: 'error',
      text: `Concept "${concept.id}" has an invalid locator: ${error}`,
    };
  }

  // Drift: capture a baseline on first query (or --reaccept), else compare.
  const current = computeAnchors(root, resolved);
  const baseline = baselineFor(loadAnchorStore(root), concept.id);
  let freshness: string;
  let drift: DriftReport | undefined;
  if (!baseline || args.reaccept) {
    captureBaseline(root, concept.id, current, new Date().toISOString());
    freshness = baseline ? 'fresh (baseline re-captured)' : 'fresh (baseline captured)';
  } else {
    drift = compareDrift(current, baseline);
    freshness = drift.status === 'drifted' ? 'DRIFTED' : 'fresh';
  }

  return { resolved, freshness, drift, text: formatConcept(concept, resolved, freshness, drift) };
}

export function formatConcept(
  concept: Concept,
  resolved: ResolvedLocation[],
  freshness?: string,
  drift?: DriftReport,
): string {
  const tag = freshness ? `, ${freshness}` : ', answered live';
  const head = `Concept \`${concept.id}\` — ${concept.title} (${resolved.length} location${resolved.length === 1 ? '' : 's'}${tag}):`;
  const body: string[] = [];
  if (concept.description) body.push(`  ${concept.description}`);

  if (concept.stages) {
    for (const stage of concept.stages) {
      body.push(`  ▸ ${stage.title}`);
      const locs = resolved.filter((r) => r.stage === stage.title);
      if (locs.length === 0) body.push('      (no match — possible drift)');
      for (const r of locs) body.push(`      ${formatLoc(r)}`);
    }
  } else {
    if (resolved.length === 0) body.push('  (nothing resolved — the locators may need updating, or the concept drifted)');
    for (const r of resolved) body.push(`  ${formatLoc(r)}`);
  }
  if (concept.note) body.push(`  note: ${concept.note}`);

  if (drift && drift.status === 'drifted') {
    body.push(
      '',
      `  ⚠ DRIFT vs baseline: ${drift.added.length} added, ${drift.removed.length} removed, ${drift.changed.length} changed.`,
    );
    for (const k of drift.added.slice(0, 5)) body.push(`    + ${k}`);
    for (const k of drift.removed.slice(0, 5)) body.push(`    - ${k}`);
    for (const k of drift.changed.slice(0, 5)) body.push(`    ~ ${k} (definition changed)`);
    body.push('  If this change is correct, re-run arch_query with reaccept:true to update the baseline.');
  }
  return [head, ...body].join('\n');
}

function formatLoc(r: ResolvedLocation): string {
  if (r.via === 'path') return `${r.file}  [file]`;
  return `${r.file}:${r.line}  [${r.kind}]  ${r.signature ?? ''}`.trimEnd();
}
