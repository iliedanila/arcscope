import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVocabulary } from './vocab-loader.js';

function withYaml(yaml: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-vocab-'));
  const p = join(dir, 'assertions.yaml');
  writeFileSync(p, yaml);
  try {
    fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loads concepts with locators and ordered stages', () => {
  withYaml(
    [
      'concepts:',
      '  repository-tokens:',
      '    title: Repo tokens',
      '    description: DI tokens',
      '    locators:',
      '      - { kind: symbol, query: "interface I*Repository", in: "libs/**" }',
      '      - { kind: path, glob: "apps/**/firestore-*.repository.ts" }',
      '  editor-state-flow:',
      '    title: Pipeline',
      '    stages:',
      '      - { title: Facade, kind: symbol, query: "class GraphEditorFacade", in: "libs/**" }',
      '      - { title: Router, kind: symbol, query: "class ActionRouterService" }',
    ].join('\n'),
    (p) => {
      const v = loadVocabulary(p);
      assert.equal(v.concepts.length, 2);
      const repo = v.concepts.find((c) => c.id === 'repository-tokens');
      assert.equal(repo?.locators?.length, 2);
      assert.equal(repo?.description, 'DI tokens');
      const flow = v.concepts.find((c) => c.id === 'editor-state-flow');
      assert.equal(flow?.stages?.length, 2);
      assert.equal(flow?.stages?.[0]?.title, 'Facade');
    },
  );
});

test('parses an import locator (of module specifier, optional in)', () => {
  withYaml(
    [
      'concepts:',
      '  firestore-boundary:',
      '    title: Firestore import perimeter',
      '    locators:',
      '      - { kind: import, of: "@angular/fire/firestore", in: "apps/**" }',
    ].join('\n'),
    (p) => {
      const loc = loadVocabulary(p).concepts[0]?.locators?.[0];
      assert.deepEqual(loc, { kind: 'import', of: '@angular/fire/firestore', in: 'apps/**' });
    },
  );
  withYaml('concepts:\n  bad:\n    locators:\n      - { kind: import, glob: x }\n', (p) => {
    assert.throws(() => loadVocabulary(p), /import.*needs an "of"/);
  });
});

test('missing file -> empty; malformed concept/locator -> clear error', () => {
  assert.equal(loadVocabulary('/no/such/assertions.yaml').concepts.length, 0);
  withYaml('concepts:\n  bad:\n    title: x\n', (p) => {
    assert.throws(() => loadVocabulary(p), /locators.*or.*stages/);
  });
  withYaml('concepts:\n  bad:\n    locators:\n      - { kind: oops, query: x }\n', (p) => {
    assert.throws(() => loadVocabulary(p), /unknown kind/);
  });
});
