import type { IndexStore } from '../engine/index-store.js';
import { resolveLocators } from './resolver.js';
import type { Concept, ResolvedLocation } from './types.js';

// One member's conformance verdict.
export interface MemberConformance {
  file: string;
  symbol?: string;
  conforms: boolean;
}

export interface ConformanceReport {
  invariantTitle?: string;
  total: number; // distinct member files checked
  conforming: number;
  violations: MemberConformance[]; // members that do NOT satisfy the invariant
}

// Check a concept's `must` invariant against the LIVE index: every member file
// must appear in the set resolved by the invariant's locators. Members outside
// that set are violations. This is the verification that makes an agent-written
// assertion safe — re-run on every read, so a wrong or stale claim surfaces as a
// violation rather than being trusted as a stored fact.
//
// Keyed by file (a concept member is a file, or a symbol's file): conformance asks
// "does this file satisfy the rule?". Returns undefined when the concept declares
// no invariant.
export function checkConformance(
  store: IndexStore,
  concept: Concept,
  members: ResolvedLocation[],
): ConformanceReport | undefined {
  if (!concept.must) return undefined;
  const satisfying = new Set(resolveLocators(store, concept.must.locators).map((r) => r.file));

  const byFile = new Map<string, ResolvedLocation>();
  for (const m of members) if (!byFile.has(m.file)) byFile.set(m.file, m);

  const verdicts: MemberConformance[] = [...byFile.values()].map((m) => ({
    file: m.file,
    symbol: m.symbol,
    conforms: satisfying.has(m.file),
  }));
  const violations = verdicts.filter((v) => !v.conforms);
  return {
    invariantTitle: concept.must.title,
    total: verdicts.length,
    conforming: verdicts.length - violations.length,
    violations,
  };
}
