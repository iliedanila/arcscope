import type { IndexStore } from '../engine/index-store.js';
import { loadKnowledge } from '../knowledge/vocab-loader.js';
import { resolveConceptSafe } from '../knowledge/resolver.js';
import { computeAnchors, compareDrift, loadAnchorStore, baselineFor } from '../knowledge/drift.js';

export interface ArchListResult {
  conceptCount: number;
  text: string;
}

// List the repo's declared architecture concepts (progressive disclosure: names +
// counts + freshness first). Resolved LIVE; read-only — never captures a baseline
// (that's arch_query's job), so unqueried concepts show as "unverified".
export async function runArchList(store: IndexStore, root: string): Promise<ArchListResult> {
  await store.sync();
  const vocab = loadKnowledge(root);
  if (vocab.concepts.length === 0) {
    return {
      conceptCount: 0,
      text: 'No architecture vocabulary found. Add named concepts to .arcscope/vocab.yaml (committed) to make this repo self-describing.',
    };
  }
  const anchorStore = loadAnchorStore(root);
  const lines = vocab.concepts.map((c) => {
    const provenance = c.source === 'agent' ? ' [agent]' : '';
    if (c.flow) {
      const recorded = baselineFor(anchorStore, c.id) ? 'recorded' : 'unverified';
      return `  ${c.id} (flow)${provenance} — ${c.title} · from ${c.flow.entry} [${recorded}] (arch_query to recompute live)`;
    }
    const { locations: resolved, error } = resolveConceptSafe(store, c);
    const label = `  ${c.id}${c.stages ? ' (staged)' : ''}${provenance} — ${c.title}`;
    if (error) return `${label} · ⚠ invalid locator: ${error}`;
    const baseline = baselineFor(anchorStore, c.id);
    const freshness = baseline ? compareDrift(computeAnchors(root, resolved), baseline).status : 'unverified';
    return `${label} · ${resolved.length} location${resolved.length === 1 ? '' : 's'} [${freshness}]`;
  });
  return {
    conceptCount: vocab.concepts.length,
    text: [
      `${vocab.concepts.length} architecture concept${vocab.concepts.length === 1 ? '' : 's'} (answered live against current code):`,
      ...lines,
      '',
      'Use arch_query <id> to resolve one concept to its live locations (and capture/check its drift baseline).',
    ].join('\n'),
  };
}
