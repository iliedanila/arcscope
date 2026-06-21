import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { runFindRefs } from './find-refs.js';

// A lib that exports `Thing` through a barrel, an app that imports it through the
// barrel, and a second file with its OWN unrelated `Thing` (the grep false-positive).
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-refs-'));
  mkdirSync(join(dir, 'libs/lib/src/lib'), { recursive: true });
  mkdirSync(join(dir, 'app'), { recursive: true });
  writeFileSync(join(dir, 'libs/lib/src/lib/thing.ts'), 'export class Thing {}\n');
  writeFileSync(join(dir, 'libs/lib/src/index.ts'), "export * from './lib/thing';\n"); // barrel
  writeFileSync(join(dir, 'app/a.ts'), "import { Thing } from '../libs/lib/src';\nexport const x = new Thing();\n");
  writeFileSync(join(dir, 'app/b.ts'), 'class Thing {}\nexport const y = new Thing();\n'); // unrelated same name
  return dir;
}

test('find_refs follows the barrel and disambiguates same-named symbols', async () => {
  const dir = fixture();
  try {
    const registry = new GrammarRegistry();
    const store = new IndexStore(dir, registry);
    const { records } = await runFindRefs(store, registry, dir, { symbol: 'Thing' });

    // app/a.ts imports Thing through the barrel -> resolves to the lib definition
    const aNew = records.find((r) => r.file === 'app/a.ts' && r.refKind === 'new');
    assert.ok(aNew, 'app/a.ts new Thing() should be a reference');
    assert.equal(aNew?.resolvesTo?.file, 'libs/lib/src/lib/thing.ts');

    // app/b.ts has its OWN local Thing -> resolves to itself, never the lib def
    const bNew = records.find((r) => r.file === 'app/b.ts' && r.refKind === 'new');
    assert.ok(bNew, 'app/b.ts new Thing() should be a reference');
    assert.equal(bNew?.resolvesTo?.file, 'app/b.ts');

    // the precision win: b's Thing must NOT be attributed to the lib (grep would)
    assert.ok(!records.some((r) => r.file === 'app/b.ts' && r.resolvesTo?.file === 'libs/lib/src/lib/thing.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('find_refs handles JavaScript referencing files (JS grammar has no type_identifier)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-refs-js-'));
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib/widget.ts'), 'export function makeWidget() {}\n');
    // a .js importer, with a NodeNext-style '.js' specifier that maps to widget.ts
    writeFileSync(join(dir, 'app.js'), "import { makeWidget } from './lib/widget.js';\nexport const w = makeWidget();\n");
    const registry = new GrammarRegistry();
    const store = new IndexStore(dir, registry);
    const { records } = await runFindRefs(store, registry, dir, { symbol: 'makeWidget' });
    // must not throw on the JS file, and must resolve the .js->.ts import + find the call
    assert.ok(records.some((r) => r.file === 'app.js' && r.refKind === 'call'), 'should find makeWidget() call in app.js');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('find_refs gives an honest out-of-tier hint for a member-access-only method', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-refs-mem-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/svc.ts'), 'export class Svc {\n  doThing() { return 1; }\n}\n');
    // reached only via member access on an instance — never imported by the name `doThing`
    writeFileSync(join(dir, 'src/use.ts'), "import { Svc } from './svc';\nconst s = new Svc();\nexport const r = s.doThing();\n");
    const registry = new GrammarRegistry();
    const store = new IndexStore(dir, registry);
    const { records, text } = await runFindRefs(store, registry, dir, { symbol: 'doThing' });

    assert.equal(records.length, 0); // tree-sitter path (no precise tier): can't see member access
    assert.match(text, /member access/);
    assert.match(text, /precise tier/); // points at the precise tier instead of a dead end
    assert.match(text, /grep `\.doThing`/); // actionable fallback
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('find_refs scopes by pathGlob and reports unknown symbols', async () => {
  const dir = fixture();
  try {
    const registry = new GrammarRegistry();
    const store = new IndexStore(dir, registry);

    const scoped = await runFindRefs(store, registry, dir, { symbol: 'Thing', pathGlob: 'app/a.ts' });
    assert.ok(scoped.records.length > 0);
    assert.ok(scoped.records.every((r) => r.file === 'app/a.ts'));

    const missing = await runFindRefs(store, registry, dir, { symbol: 'Nope' });
    assert.equal(missing.records.length, 0);
    assert.match(missing.text, /No definition of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
