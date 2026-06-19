import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { runArchQuery } from './arch-query.js';
import { runArchList } from './arch-list.js';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-arch-'));
  mkdirSync(join(dir, '.arcscope'), { recursive: true });
  mkdirSync(join(dir, 'libs/data/interfaces'), { recursive: true });
  mkdirSync(join(dir, 'libs/feat/services'), { recursive: true });
  writeFileSync(
    join(dir, 'libs/data/interfaces/repos.ts'),
    'export interface IUserRepository {}\nexport interface IDocRepository {}\nexport interface Helper {}\n',
  );
  writeFileSync(join(dir, 'libs/feat/services/facade.ts'), 'export class GraphEditorFacade {}\n');
  writeFileSync(join(dir, 'libs/feat/services/router.ts'), 'export class ActionRouterService {}\n');
  writeFileSync(
    join(dir, '.arcscope/vocab.yaml'),
    [
      'concepts:',
      '  repository-tokens:',
      '    title: Repository interfaces',
      '    locators:',
      '      - { kind: symbol, query: "interface I*Repository", in: "libs/data/**" }',
      '  editor-state-flow:',
      '    title: Pipeline',
      '    stages:',
      '      - { title: Facade, kind: symbol, query: "class GraphEditorFacade", in: "libs/feat/**" }',
      '      - { title: Router, kind: symbol, query: "class ActionRouterService", in: "libs/feat/**" }',
    ].join('\n'),
  );
  return dir;
}

test('arch_query resolves a symbol concept live (name glob + scope)', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const { resolved } = await runArchQuery(store, dir, { concept: 'repository-tokens' });
    assert.deepEqual(resolved.map((r) => r.symbol).sort(), ['IDocRepository', 'IUserRepository']); // Helper excluded
    assert.ok(resolved.every((r) => r.kind === 'interface'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch_query returns staged concepts in order', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const { resolved, text } = await runArchQuery(store, dir, { concept: 'editor-state-flow' });
    assert.deepEqual(
      resolved.map((r) => r.stage),
      ['Facade', 'Router'],
    );
    assert.deepEqual(
      resolved.map((r) => r.symbol),
      ['GraphEditorFacade', 'ActionRouterService'],
    );
    assert.match(text, /Facade/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift: baseline on first query, flagged after a change, cleared by reaccept', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const first = await runArchQuery(store, dir, { concept: 'repository-tokens' });
    assert.match(first.freshness, /baseline captured/);

    const second = await runArchQuery(store, dir, { concept: 'repository-tokens' });
    assert.equal(second.freshness, 'fresh'); // unchanged

    // add a new matching interface -> drift (added)
    writeFileSync(
      join(dir, 'libs/data/interfaces/repos.ts'),
      'export interface IUserRepository {}\nexport interface IDocRepository {}\nexport interface INewRepository {}\nexport interface Helper {}\n',
    );
    const third = await runArchQuery(store, dir, { concept: 'repository-tokens' });
    assert.equal(third.drift?.status, 'drifted');
    assert.ok(third.drift?.added.some((k) => k.includes('INewRepository')));
    assert.match(third.text, /DRIFT vs baseline/);

    // reaccept -> baseline updated -> fresh again
    await runArchQuery(store, dir, { concept: 'repository-tokens', reaccept: true });
    const after = await runArchQuery(store, dir, { concept: 'repository-tokens' });
    assert.equal(after.freshness, 'fresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift detects a changed definition signature (plausible-but-wrong case)', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    await runArchQuery(store, dir, { concept: 'editor-state-flow' }); // baseline
    writeFileSync(join(dir, 'libs/feat/services/facade.ts'), 'export class GraphEditorFacade extends Object {}\n');
    const drifted = await runArchQuery(store, dir, { concept: 'editor-state-flow' });
    assert.equal(drifted.drift?.status, 'drifted');
    assert.ok(drifted.drift?.changed.some((k) => k.includes('GraphEditorFacade')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch_list counts live; unknown concept is handled', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const list = await runArchList(store, dir);
    assert.equal(list.conceptCount, 2);
    assert.match(list.text, /repository-tokens/);
    const miss = await runArchQuery(store, dir, { concept: 'nope' });
    assert.match(miss.text, /No concept "nope"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
