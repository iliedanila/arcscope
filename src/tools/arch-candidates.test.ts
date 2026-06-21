import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { runArchAssert } from './arch-assert.js';
import { runArchCandidates } from './arch-candidates.js';

// Fixture: the canonical clone helper, two app members that import it, and an
// orphan that RE-IMPLEMENTS the helper's internals with DIFFERENT names and no
// shared import — the case name/import matching misses but structure catches.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-cand-'));
  mkdirSync(join(dir, 'libs'), { recursive: true });
  mkdirSync(join(dir, 'apps'), { recursive: true });
  mkdirSync(join(dir, 'functions'), { recursive: true });

  writeFileSync(
    join(dir, 'libs/graph-clone.ts'),
    `export function cloneGraphForDocument(nodes, mapping) {
  const result = [];
  for (const node of nodes) { result.push(cloneNode(node, mapping)); }
  return result;
}
export function cloneNode(node, mapping) {
  const next = { id: mapping.get(node.id), elements: [] };
  for (const el of node.elements) {
    if (el.link) { next.elements.push(cloneElement(el, mapping)); }
    else { next.elements.push(el); }
  }
  return next;
}
export function cloneElement(el, mapping) {
  const out = { id: mapping.get(el.id), link: el.link };
  if (el.target) { out.target = mapping.get(el.target); }
  else { out.target = null; }
  return out;
}
`,
  );

  writeFileSync(
    join(dir, 'apps/template-clone.ts'),
    `import { cloneGraphForDocument } from '@lib/graph-clone';
import { normalizeLinkOrderForCanvas } from '@lib/link-order';
export function templateClone(doc, mapping) {
  const nodes = cloneGraphForDocument(doc.nodes, mapping);
  return normalizeLinkOrderForCanvas(nodes);
}
`,
  );
  writeFileSync(
    join(dir, 'apps/fork-document.ts'),
    `import { cloneGraphForDocument } from '@lib/graph-clone';
import { normalizeLinkOrderForCanvas } from '@lib/link-order';
export function forkDocument(doc, mapping) {
  const nodes = cloneGraphForDocument(doc.nodes, mapping);
  return normalizeLinkOrderForCanvas(nodes);
}
`,
  );

  // The orphan: copyNode/copyElement are cloneNode/cloneElement renamed (same
  // shape). It imports NEITHER the helper NOR the badge re-numberer.
  writeFileSync(
    join(dir, 'functions/clone-template-content.ts'),
    `export function copyNode(item, table) {
  const fresh = { id: table.get(item.id), elements: [] };
  for (const piece of item.elements) {
    if (piece.link) { fresh.elements.push(copyElement(piece, table)); }
    else { fresh.elements.push(piece); }
  }
  return fresh;
}
export function copyElement(piece, table) {
  const made = { id: table.get(piece.id), link: piece.link };
  if (piece.target) { made.target = table.get(piece.target); }
  else { made.target = null; }
  return made;
}
`,
  );
  return dir;
}

test('arch_candidates finds a renamed re-implementation by STRUCTURE (name-independent) and flags the invariant violation', async () => {
  const dir = fixture();
  try {
    // A concept whose members are the importers of the helper, with the badge invariant.
    // The orphan is deliberately NOT pinned — we want to DISCOVER it.
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    await runArchAssert(dir, {
      id: 'document-copy',
      title: 'Document copy paths',
      locators: [{ kind: 'import', of: '@lib/graph-clone' }],
      must: { title: 're-numbers link badges', locators: [{ kind: 'import', of: '@lib/link-order' }] },
    });

    const res = await runArchCandidates(store, dir, { concept: 'document-copy' });

    // The orphan surfaces — matched on shape despite copyNode != cloneNode.
    const orphanHits = res.candidates.filter((c) => c.file === 'functions/clone-template-content.ts');
    assert.ok(orphanHits.length >= 1, 'orphan file flagged as a structural candidate');
    assert.ok(orphanHits.some((c) => c.name === 'copyNode')); // renamed — proves name-independence
    assert.ok(orphanHits.every((c) => c.score >= 0.8));

    // Every candidate is the orphan (members + canonical helper are excluded).
    assert.ok(res.candidates.every((c) => c.file === 'functions/clone-template-content.ts'));

    // It does not satisfy the invariant -> flagged as the dangerous kind.
    assert.match(res.text, /would VIOLATE invariant/);
    assert.match(res.text, /functions\/clone-template-content\.ts/);
    assert.match(res.text, /structural-similarity tier/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch_candidates: once the orphan is pinned as a member, it is no longer a candidate', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    await runArchAssert(dir, {
      id: 'document-copy',
      title: 'Document copy paths',
      locators: [
        { kind: 'import', of: '@lib/graph-clone' },
        { kind: 'path', glob: 'functions/**/clone-template-content.ts' }, // now pinned
      ],
    });

    const res = await runArchCandidates(store, dir, { concept: 'document-copy' });
    assert.ok(
      res.candidates.every((c) => c.file !== 'functions/clone-template-content.ts'),
      'a pinned member is excluded from candidates',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch_candidates handles an unknown concept gracefully', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const res = await runArchCandidates(store, dir, { concept: 'nope' });
    assert.deepEqual(res.candidates, []);
    assert.match(res.text, /No concept "nope"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Refutes the review's "stale fingerprint" blocker: fingerprints key on SOURCE,
// and candidates recompute from the (freshly re-read) concept every call — so
// re-asserting the concept in the SAME store, with no source change, is reflected.
test('re-asserting a concept in the same store is reflected immediately (no stale candidates)', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    await runArchAssert(dir, {
      id: 'document-copy',
      title: 'Document copy paths',
      locators: [{ kind: 'import', of: '@lib/graph-clone' }],
    });
    const before = await runArchCandidates(store, dir, { concept: 'document-copy' });
    assert.ok(before.candidates.some((c) => c.file === 'functions/clone-template-content.ts'));

    await runArchAssert(dir, {
      id: 'document-copy',
      title: 'Document copy paths',
      locators: [
        { kind: 'import', of: '@lib/graph-clone' },
        { kind: 'path', glob: 'functions/**/clone-template-content.ts' }, // now pinned
      ],
    });
    const after = await runArchCandidates(store, dir, { concept: 'document-copy' });
    assert.ok(
      after.candidates.every((c) => c.file !== 'functions/clone-template-content.ts'),
      'the re-asserted (now-pinned) member is excluded on the very next call',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed must invariant degrades — candidates still returned, no crash, no violation flag', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    await runArchAssert(dir, {
      id: 'document-copy',
      title: 'Document copy paths',
      locators: [{ kind: 'import', of: '@lib/graph-clone' }],
      must: { title: 'bad', locators: [{ kind: 'symbol', query: 'noSpaceHere' }] }, // invalid query
    });
    const res = await runArchCandidates(store, dir, { concept: 'document-copy' });
    assert.ok(res.candidates.some((c) => c.file === 'functions/clone-template-content.ts'));
    assert.doesNotMatch(res.text, /would VIOLATE/); // invariant couldn't be evaluated → not flagged
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
