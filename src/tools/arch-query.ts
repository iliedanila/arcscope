import { z } from 'zod';
import type { IndexStore } from '../engine/index-store.js';
import { loadKnowledge } from '../knowledge/vocab-loader.js';
import { resolveConceptSafe } from '../knowledge/resolver.js';
import { checkConformance } from '../knowledge/conformance.js';
import type { ConformanceReport } from '../knowledge/conformance.js';
import { computeAnchors, compareDrift, loadAnchorStore, baselineFor, captureBaseline } from '../knowledge/drift.js';
import type { Anchor, DriftReport } from '../knowledge/drift.js';
import type { Concept, ResolvedLocation } from '../knowledge/types.js';
import type { ProgramStore } from '../engine/program-store.js';
import { resolveFlow } from './flow.js';

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
  conformance?: ConformanceReport;
  text: string;
}

// Resolve one named concept LIVE against the current tree — never cached prose.
// Loads the agent-written assertions, flags drift, and (when the concept declares a
// `must` invariant) re-checks conformance every call.
export async function runArchQuery(
  store: IndexStore,
  root: string,
  args: { concept: string; reaccept?: boolean },
  programStore?: ProgramStore,
): Promise<ArchQueryResult> {
  const sync = await store.sync();
  const vocab = loadKnowledge(root);
  const concept = vocab.concepts.find((c) => c.id === args.concept);
  if (!concept) {
    const known = vocab.concepts.length
      ? ` Known concepts: ${vocab.concepts.map((c) => c.id).join(', ')}.`
      : ' (.arcscope/assertions.yaml is missing or empty — record one with arch_assert.)';
    return { resolved: [], freshness: 'unknown', text: `No concept "${args.concept}" in the vocabulary.${known}` };
  }

  if (concept.flow) {
    // The flow's precise Program must not be stale: this sync already consumed any
    // change, so invalidate here (resolveFlow's own sync would see nothing changed).
    if (programStore && (sync.changed > 0 || sync.removed > 0)) programStore.invalidate();
    return runFlowConcept(store, root, concept, args, programStore);
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

  const conformance = checkConformance(store, concept, resolved);

  return {
    resolved,
    freshness,
    drift,
    conformance,
    text: formatConcept(concept, resolved, freshness, drift, conformance),
  };
}

// A flow concept (concept.flow): recompute the flow LIVE via the precise tier and
// drift on its membership — a function entering or leaving the flow. This is the v2
// "store an assertion, re-verify on read" principle applied to a whole flow.
async function runFlowConcept(
  store: IndexStore,
  root: string,
  concept: Concept,
  args: { reaccept?: boolean },
  programStore?: ProgramStore,
): Promise<ArchQueryResult> {
  if (!programStore) {
    return { resolved: [], freshness: 'unknown', text: `Flow concept "${concept.id}" needs the precise tier, which is unavailable here.` };
  }
  const fr = await resolveFlow(store, programStore, root, { symbol: concept.flow!.entry, pathGlob: concept.flow!.pathGlob });
  if (!fr.ok) return { resolved: [], freshness: 'error', text: `Flow concept "${concept.id}": ${fr.text}` };

  const anchors: Anchor[] = fr.members.map((m) => ({
    key: m.symbol === '(anonymous)' ? `${m.file}:${m.line}` : `${m.file}#${m.symbol}`,
    hash: 'present',
  }));
  const baseline = baselineFor(loadAnchorStore(root), concept.id);
  let freshness: string;
  let drift: DriftReport | undefined;
  if (!baseline || args.reaccept) {
    captureBaseline(root, concept.id, anchors, new Date().toISOString());
    freshness = baseline ? 'fresh (baseline re-captured)' : 'fresh (baseline captured)';
  } else {
    drift = compareDrift(anchors, baseline);
    freshness = drift.status === 'drifted' ? 'DRIFTED' : 'fresh';
  }

  const lines = [`Flow concept \`${concept.id}\` — ${concept.title} (${fr.members.length} functions, ${freshness}):`];
  if (concept.description) lines.push(`  ${concept.description}`);
  if (concept.note) lines.push(`  note: ${concept.note}`);
  lines.push('', fr.text);
  if (drift && drift.status === 'drifted') {
    lines.push('', `  ⚠ FLOW DRIFT vs baseline: ${drift.added.length} entered, ${drift.removed.length} left the flow.`);
    for (const k of drift.added.slice(0, 8)) lines.push(`    + ${k}`);
    for (const k of drift.removed.slice(0, 8)) lines.push(`    - ${k}`);
    lines.push('  If this change is correct, re-run arch_query with reaccept:true to update the baseline.');
  }
  return { resolved: [], freshness, drift, text: lines.join('\n') };
}

export function formatConcept(
  concept: Concept,
  resolved: ResolvedLocation[],
  freshness?: string,
  drift?: DriftReport,
  conformance?: ConformanceReport,
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

  if (conformance) {
    const label = conformance.invariantTitle ? `: ${conformance.invariantTitle}` : '';
    if (conformance.error) {
      body.push('', `  ⚠ conformance${label} could not be evaluated — invalid invariant locator: ${conformance.error}`);
    } else if (conformance.violations.length === 0) {
      body.push('', `  ✓ conformance${label} — all ${conformance.total} members satisfy the invariant.`);
    } else {
      body.push(
        '',
        `  ✗ CONFORMANCE${label} — ${conformance.violations.length} of ${conformance.total} members VIOLATE the invariant:`,
      );
      for (const v of conformance.violations.slice(0, 10)) {
        body.push(`    ✗ ${v.file}${v.symbol ? ` (${v.symbol})` : ''} — does not satisfy the rule`);
      }
    }
  }
  return [head, ...body].join('\n');
}

function formatLoc(r: ResolvedLocation): string {
  if (r.via === 'symbol') return `${r.file}:${r.line}  [${r.kind}]  ${r.signature ?? ''}`.trimEnd();
  return `${r.file}  [${r.via === 'import' ? 'imports' : 'file'}]`;
}
