import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammarRegistry } from './grammar-registry.js';
import { extractImports } from './imports.js';
import type { ImportEdge } from './types.js';

async function edgesFor(source: string): Promise<ImportEdge[]> {
  const registry = new GrammarRegistry();
  const parser = await registry.ensureInit();
  const grammar = await registry.getGrammar('typescript');
  parser.setLanguage(grammar.language);
  const tree = parser.parse(source);
  if (!tree) return [];
  try {
    return extractImports('f.ts', tree);
  } finally {
    tree.delete();
  }
}

test('extracts every import form', async () => {
  const edges = await edgesFor(
    [
      "import './side';",
      "import D from './d';",
      "import * as NS from './ns';",
      "import { A, B as C } from './ab';",
      "import type { T } from './t';",
    ].join('\n'),
  );
  const by = new Map(edges.map((e) => [e.specifier, e]));
  assert.equal(by.get('./side')?.names.length, 0); // side-effect
  assert.deepEqual(by.get('./d')?.names, [{ imported: 'default', local: 'D' }]);
  assert.equal(by.get('./ns')?.star, true);
  assert.deepEqual(by.get('./ns')?.names, [{ imported: '*', local: 'NS' }]);
  assert.deepEqual(by.get('./ab')?.names, [
    { imported: 'A', local: 'A' },
    { imported: 'B', local: 'C' }, // `B as C` -> imported B, local C
  ]);
  assert.deepEqual(by.get('./t')?.names, [{ imported: 'T', local: 'T' }]); // type import is still an edge
  assert.ok(edges.every((e) => e.kind === 'import'));
});

test('extracts re-export (barrel) forms and ignores local exports', async () => {
  const edges = await edgesFor(
    [
      "export { X, Y as Z } from './xy';",
      "export * from './star';",
      "export * as Agg from './agg';",
      'export const local = 1;',
      'export class Foo {}',
    ].join('\n'),
  );
  assert.equal(edges.filter((e) => e.kind === 're-export').length, 3); // local export + class are not edges
  const xy = edges.find((e) => e.specifier === './xy');
  assert.equal(xy?.star, false);
  assert.deepEqual(xy?.names, [
    { imported: 'X', local: 'X' },
    { imported: 'Y', local: 'Z' }, // `Y as Z` -> exported-as Z
  ]);
  const star = edges.find((e) => e.specifier === './star');
  assert.equal(star?.star, true);
  assert.equal(star?.names.length, 0);
  assert.deepEqual(edges.find((e) => e.specifier === './agg')?.names, [{ imported: '*', local: 'Agg' }]);
});
