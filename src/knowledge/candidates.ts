import type { IndexStore, FileFingerprints } from '../engine/index-store.js';
import type { FunctionFingerprint } from '../engine/clone-detect.js';
import { similarity } from '../engine/clone-detect.js';
import type { Concept, Locator } from './types.js';

// A suspected re-implementation: a function elsewhere whose STRUCTURE matches the
// concept's implementation, regardless of names/imports. Heuristic — labeled its
// own precision tier so it is never mistaken for a confirmed member.
export interface CandidateMatch {
  file: string;
  name: string;
  line: number;
  score: number; // best structural similarity to a reference function (0..1)
  resembles: string; // "<refFile>:<refName>" it most resembles
  precisionTier: 'structural-similarity';
}

export interface ReferenceSet {
  references: { file: string; fn: FunctionFingerprint }[];
  referenceFiles: Set<string>; // canonical + member files — excluded from candidates
}

// Derive the functions that represent a concept's canonical implementation.
// `memberFiles` (already resolved across ALL locator kinds) seeds the set — so for
// symbol/path-bound concepts the members ARE the implementation. For an
// import-bound concept whose members are the IMPORTERS, we additionally pull in the
// files that define the symbols imported across that boundary (the real helper).
// referenceFiles doubles as the exclude set so references never report themselves.
export function referencesForConcept(
  store: IndexStore,
  concept: Concept,
  memberFiles: string[],
  allFps: FileFingerprints[],
): ReferenceSet {
  const referenceFiles = new Set(memberFiles);
  const locators: Locator[] = [...(concept.locators ?? []), ...(concept.stages ?? [])];
  for (const loc of locators) {
    if (loc.kind !== 'import') continue;
    for (const e of store.allEdges()) {
      if (e.specifier !== loc.of && !e.specifier.startsWith(loc.of + '/')) continue;
      for (const b of e.names) {
        if (b.imported === 'default' || b.imported === '*') continue;
        for (const def of store.find(b.imported)) referenceFiles.add(def.file);
      }
    }
  }

  const fpByFile = new Map(allFps.map((f) => [f.file, f.fns]));
  const references: { file: string; fn: FunctionFingerprint }[] = [];
  for (const file of referenceFiles) {
    for (const fn of fpByFile.get(file) ?? []) references.push({ file, fn });
  }
  return { references, referenceFiles };
}

// Find functions across the repo that structurally resemble any reference function
// above `threshold`, excluding the reference files themselves. Ranked by score.
export function findReimplementations(
  allFps: FileFingerprints[],
  references: { file: string; fn: FunctionFingerprint }[],
  opts: { exclude: Set<string>; threshold: number; limit: number },
): CandidateMatch[] {
  const out: CandidateMatch[] = [];
  for (const { file, fns } of allFps) {
    if (opts.exclude.has(file)) continue;
    for (const fn of fns) {
      let best = 0;
      let bestRef = '';
      for (const ref of references) {
        const s = similarity(fn, ref.fn);
        if (s > best) {
          best = s;
          bestRef = `${ref.file}:${ref.fn.name}`;
        }
      }
      if (best >= opts.threshold) {
        out.push({
          file,
          name: fn.name,
          line: fn.line,
          score: Math.round(best * 100) / 100,
          resembles: bestRef,
          precisionTier: 'structural-similarity',
        });
      }
    }
  }
  out.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return out.slice(0, opts.limit);
}
