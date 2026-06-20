import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedLocation } from './types.js';

// One anchor: a stable key for a resolved location + a content hash. Drift is
// measured against the SET of anchors and their hashes — so the dangerous case
// ("still resolves to a plausible-but-wrong set after a refactor") shows up as a
// changed hash, not just a collapsed count.
export interface Anchor {
  key: string;
  hash: string;
}

export interface DriftReport {
  status: 'fresh' | 'drifted';
  added: string[];
  removed: string[];
  changed: string[];
}

interface AnchorStore {
  concepts: Record<string, { anchors: Anchor[]; capturedAt: string }>;
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

// Symbol anchors hash the def's kind+signature (so a header change drifts but a
// pure line move does not); path anchors hash the file's content.
export function computeAnchors(root: string, resolved: ResolvedLocation[]): Anchor[] {
  const byKey = new Map<string, Anchor>();
  const fileCache = new Map<string, string>();
  for (const r of resolved) {
    let anchor: Anchor;
    if (r.via === 'symbol') {
      anchor = { key: `${r.file}#${r.symbol}`, hash: sha1(`${r.kind} ${r.signature ?? ''}`) };
    } else if (r.via === 'import') {
      // Import perimeter: drift on SET membership (who imports), not file content —
      // editing an importer is not a boundary change; gaining/losing one is.
      anchor = { key: `import:${r.file}`, hash: 'present' };
    } else {
      let content = fileCache.get(r.file);
      if (content === undefined) {
        try {
          content = readFileSync(join(root, r.file), 'utf8');
        } catch {
          content = '';
        }
        fileCache.set(r.file, content);
      }
      anchor = { key: r.file, hash: sha1(content) };
    }
    byKey.set(anchor.key, anchor); // dedupe overlapping locators
  }
  return [...byKey.values()];
}

export function compareDrift(current: Anchor[], baseline: Anchor[]): DriftReport {
  const cur = new Map(current.map((a) => [a.key, a.hash]));
  const base = new Map(baseline.map((a) => [a.key, a.hash]));
  const added = [...cur.keys()].filter((k) => !base.has(k));
  const removed = [...base.keys()].filter((k) => !cur.has(k));
  const changed = [...cur.keys()].filter((k) => base.has(k) && base.get(k) !== cur.get(k));
  return { status: added.length || removed.length || changed.length ? 'drifted' : 'fresh', added, removed, changed };
}

function anchorsPath(root: string): string {
  return join(root, '.arcscope', 'anchors.json');
}

// Local, gitignored baseline (per the chosen drift model).
export function loadAnchorStore(root: string): AnchorStore {
  const p = anchorsPath(root);
  if (!existsSync(p)) return { concepts: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'concepts' in parsed) return parsed as AnchorStore;
  } catch {
    // corrupt -> start fresh
  }
  return { concepts: {} };
}

export function baselineFor(store: AnchorStore, conceptId: string): Anchor[] | undefined {
  return store.concepts[conceptId]?.anchors;
}

export function captureBaseline(root: string, conceptId: string, anchors: Anchor[], nowIso: string): void {
  const store = loadAnchorStore(root);
  store.concepts[conceptId] = { anchors, capturedAt: nowIso };
  mkdirSync(join(root, '.arcscope'), { recursive: true });
  writeFileSync(anchorsPath(root), JSON.stringify(store, null, 2) + '\n', 'utf8');
}
