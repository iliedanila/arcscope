import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { runArchAssert } from './arch-assert.js';
import { runArchQuery } from './arch-query.js';
import { runArchList } from './arch-list.js';
import type { AssertionInput } from '../knowledge/assertion-store.js';

// A fixture mirroring the real document-copy bug:
//  - two app paths import the shared clone helper AND the badge re-numberer,
//  - one cloud-function path HAND-MIRRORS the clone (imports neither) — the orphan
//    that shares no signal with the others and got missed in the real fix.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-assert-'));
  mkdirSync(join(dir, 'apps'), { recursive: true });
  mkdirSync(join(dir, 'functions'), { recursive: true });
  writeFileSync(
    join(dir, 'apps/template-clone.ts'),
    "import { cloneGraphForDocument } from '@lib/graph-clone';\n" +
      "import { normalizeLinkOrderForCanvas } from '@lib/link-order';\n" +
      'export function templateClone() { return cloneGraphForDocument(normalizeLinkOrderForCanvas([])); }\n',
  );
  writeFileSync(
    join(dir, 'apps/fork-document.ts'),
    "import { cloneGraphForDocument } from '@lib/graph-clone';\n" +
      "import { normalizeLinkOrderForCanvas } from '@lib/link-order';\n" +
      'export function forkDocument() { return cloneGraphForDocument(normalizeLinkOrderForCanvas([])); }\n',
  );
  // The orphan: imports neither helper — it re-implements the clone by hand and
  // forgets to re-number badges. Pinned into the concept by a path locator.
  writeFileSync(
    join(dir, 'functions/clone-template-content.ts'),
    'export function cloneTemplateContent() { return { cloned: true }; }\n',
  );
  return dir;
}

const DOCUMENT_COPY: AssertionInput = {
  id: 'document-copy',
  title: 'Document copy paths',
  description: 'Every way a document is copied.',
  locators: [
    { kind: 'import', of: '@lib/graph-clone' }, // self-maintaining: the app paths
    { kind: 'path', glob: 'functions/**/clone-template-content.ts' }, // the pinned orphan
  ],
  must: {
    title: 're-numbers link badges',
    locators: [{ kind: 'import', of: '@lib/link-order' }],
  },
};

test('A→B: an asserted concept persists and a fresh session inherits it + its conformance verdict', async () => {
  const dir = fixture();
  try {
    // ── Session A: record the assertion. Nothing is held in memory afterward. ──
    const storeA = new IndexStore(dir, new GrammarRegistry());
    await storeA.sync();
    await runArchAssert(dir, DOCUMENT_COPY);
    assert.ok(existsSync(join(dir, '.arcscope/assertions.yaml')), 'assertion persisted to disk');
    // assertions.yaml is the single knowledge source — no legacy human-authored vocab.yaml.
    assert.ok(!existsSync(join(dir, '.arcscope/vocab.yaml')));

    // ── Session B: a brand-new store (no carryover) reads the assertion off disk. ──
    const storeB = new IndexStore(dir, new GrammarRegistry());
    const res = await runArchQuery(storeB, dir, { concept: 'document-copy' });

    // It inherited the concept and resolved all three members live.
    assert.deepEqual(
      res.resolved.map((r) => r.file).sort(),
      ['apps/fork-document.ts', 'apps/template-clone.ts', 'functions/clone-template-content.ts'],
    );

    // And it flagged the orphan as a conformance violation — a path session B never
    // independently discovered, caught only because the assertion re-checks the rule.
    assert.equal(res.conformance?.total, 3);
    assert.equal(res.conformance?.conforming, 2);
    assert.deepEqual(
      res.conformance?.violations.map((v) => v.file),
      ['functions/clone-template-content.ts'],
    );
    assert.match(res.text, /CONFORMANCE/);
    assert.match(res.text, /functions\/clone-template-content\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixing the orphan clears the violation (conformance re-checks live)', async () => {
  const dir = fixture();
  try {
    const storeA = new IndexStore(dir, new GrammarRegistry());
    await storeA.sync();
    await runArchAssert(dir, DOCUMENT_COPY);

    // The fix: the orphan now imports the badge re-numberer too.
    writeFileSync(
      join(dir, 'functions/clone-template-content.ts'),
      "import { normalizeLinkOrderForCanvas } from '@lib/link-order';\n" +
        'export function cloneTemplateContent() { return { cloned: normalizeLinkOrderForCanvas([]) }; }\n',
    );

    const storeB = new IndexStore(dir, new GrammarRegistry());
    const res = await runArchQuery(storeB, dir, { concept: 'document-copy' });
    assert.equal(res.conformance?.violations.length, 0);
    assert.match(res.text, /✓ conformance/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch_list shows the asserted concept', async () => {
  const dir = fixture();
  try {
    const storeA = new IndexStore(dir, new GrammarRegistry());
    await storeA.sync();
    await runArchAssert(dir, DOCUMENT_COPY);

    const storeB = new IndexStore(dir, new GrammarRegistry());
    const list = await runArchList(storeB, dir);
    assert.equal(list.conceptCount, 1);
    assert.match(list.text, /document-copy — Document copy paths/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-asserting the same id updates in place; a second assertion is preserved', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    await runArchAssert(dir, DOCUMENT_COPY);
    await runArchAssert(dir, { ...DOCUMENT_COPY, title: 'Document copy paths (revised)' });
    await runArchAssert(dir, {
      id: 'persistence-island',
      title: 'Persistence island',
      locators: [{ kind: 'import', of: '@lib/graph-clone' }],
    });

    const list = await runArchList(new IndexStore(dir, new GrammarRegistry()), dir);
    assert.equal(list.conceptCount, 2); // updated, not duplicated
    assert.match(list.text, /Document copy paths \(revised\)/);
    assert.match(list.text, /persistence-island/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
