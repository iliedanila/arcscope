import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammarRegistry } from './grammar-registry.js';
import { fingerprintTree, similarity } from './clone-detect.js';
import type { FunctionFingerprint } from './clone-detect.js';

async function fingerprintsOf(src: string): Promise<FunctionFingerprint[]> {
  const reg = new GrammarRegistry();
  const grammar = await reg.getForExt('.ts');
  const parser = await reg.ensureInit();
  parser.setLanguage(grammar!.language);
  const tree = parser.parse(src);
  if (!tree) return [];
  try {
    return fingerprintTree(tree);
  } finally {
    tree.delete();
  }
}

const find = (fps: FunctionFingerprint[], name: string): FunctionFingerprint =>
  fps.find((f) => f.name === name)!;

// Same structure, every identifier renamed (incl. the called helper) — a Type-2
// clone. Structural fingerprinting must score these identical.
const CLONE_A = `
export function cloneNode(node, mapping) {
  const next = { id: mapping.get(node.id), elements: [] };
  for (const el of node.elements) {
    if (el.link) { next.elements.push(cloneElement(el, mapping)); }
    else { next.elements.push(el); }
  }
  return next;
}`;
const CLONE_B_RENAMED = `
function copyNode(item, table) {
  const fresh = { id: table.get(item.id), elements: [] };
  for (const piece of item.elements) {
    if (piece.link) { fresh.elements.push(copyElement(piece, table)); }
    else { fresh.elements.push(piece); }
  }
  return fresh;
}`;
const UNRELATED = `
function unrelated(a, b) {
  switch (a) {
    case 1: return b + 1;
    case 2: return b - 1;
    default: return 0;
  }
}`;
const TRIVIAL = `function tiny() { return 1; }`;

// A REALISTICALLY diverged clone (Type-3): renamed + type annotations + an `as`
// cast + `??` + an extra guard + a wrapper call — the shape a real hand-mirror
// takes. Empirical tuning showed the original K=5 build scored this kind of divergence
// ~0.3 and silently missed the actual re-implementation. This locks in the K=3
// separation that catches it.
const DIVERGED_FROM_A = `
function copyNode(item: SourceNode, table: Map<string, string>): ClonedNode {
  const fresh: ClonedNode = { id: table.get(item.id) as string, elements: [] };
  if (!item.elements) { return fresh; }
  for (const piece of toArray(item.elements)) {
    if (piece.link ?? false) { fresh.elements.push(copyElement(piece, table)); }
    else { fresh.elements.push(piece); }
  }
  return fresh;
}`;

test('renamed-only clone (different names, same shape) scores 1.0 — name-independent', async () => {
  const fps = await fingerprintsOf(CLONE_A + CLONE_B_RENAMED);
  assert.equal(similarity(find(fps, 'cloneNode'), find(fps, 'copyNode')), 1);
});

test('structurally different functions score low', async () => {
  const fps = await fingerprintsOf(CLONE_A + UNRELATED);
  assert.ok(similarity(find(fps, 'cloneNode'), find(fps, 'unrelated')) < 0.4);
});

test('trivial functions are skipped (below the size floor)', async () => {
  const fps = await fingerprintsOf(CLONE_A + TRIVIAL);
  assert.deepEqual(fps.map((f) => f.name), ['cloneNode']); // tiny() omitted
});

test('a realistically diverged clone is detected and stays well clear of unrelated code', async () => {
  const fps = await fingerprintsOf(CLONE_A + DIVERGED_FROM_A + UNRELATED);
  const clone = similarity(find(fps, 'cloneNode'), find(fps, 'copyNode'));
  const noise = similarity(find(fps, 'cloneNode'), find(fps, 'unrelated'));
  assert.ok(clone >= 0.3, `diverged clone should score >= 0.3, got ${clone.toFixed(3)}`);
  assert.ok(noise < 0.15, `unrelated should score < 0.15, got ${noise.toFixed(3)}`);
  assert.ok(clone > noise * 2.5, `clone (${clone.toFixed(3)}) must separate clearly from noise (${noise.toFixed(3)})`);
});
