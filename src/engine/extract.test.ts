import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammarRegistry } from './grammar-registry.js';
import { extractDefs } from './extract.js';
import type { DefRecord } from './types.js';

const TS_SAMPLE = `
import { Base } from './base';

export function topFn(a: number, b: string): string { return b; }
export const arrowFn = (x: number): number => x * 2;

export class Widget extends Base implements IThing {
  private count = 0;
  doThing(n: number): void {}
  get label(): string { return ''; }
  constructor() { super(); }
}

export abstract class AbstractWidget {
  abstract render(): void;
}

export interface IThing { id: string; }
export type Alias = string | number;
export enum Color { Red, Green, Blue }
export namespace Geometry { export const PI = 3.14; }
declare function ambient(x: number): void;
`;

async function defsFor(grammarId: string, source: string): Promise<DefRecord[]> {
  const registry = new GrammarRegistry();
  const parser = await registry.ensureInit();
  const grammar = await registry.getGrammar(grammarId);
  parser.setLanguage(grammar.language);
  const tree = parser.parse(source);
  if (!tree) return [];
  try {
    return extractDefs(grammar.query, 'sample', tree);
  } finally {
    tree.delete();
  }
}

test('TS extraction covers all common definition kinds incl. augmented forms', async () => {
  const defs = await defsFor('typescript', TS_SAMPLE);
  const byName = new Map(defs.map((d) => [d.symbol, d]));

  // js-tags + ts-tags + arcscope extras, end to end:
  assert.equal(byName.get('topFn')?.kind, 'function');
  assert.equal(byName.get('arrowFn')?.kind, 'function'); // dedup keeps function over constant
  assert.equal(byName.get('Widget')?.kind, 'class');
  assert.equal(byName.get('doThing')?.kind, 'method');
  assert.equal(byName.get('AbstractWidget')?.kind, 'class');
  assert.equal(byName.get('render')?.kind, 'method');
  assert.equal(byName.get('IThing')?.kind, 'interface');
  assert.equal(byName.get('Alias')?.kind, 'type'); // arcscope extra
  assert.equal(byName.get('Color')?.kind, 'enum'); // arcscope extra
  assert.equal(byName.get('Geometry')?.kind, 'module'); // namespace, arcscope extra
  assert.equal(byName.get('PI')?.kind, 'constant'); // exported const, arcscope extra
  assert.equal(byName.get('ambient')?.kind, 'function');

  // constructors are intentionally excluded
  assert.equal(byName.has('constructor'), false);
});

test('signature is the definition header line, not the whole body', async () => {
  const defs = await defsFor('typescript', TS_SAMPLE);
  const widget = defs.find((d) => d.symbol === 'Widget');
  assert.ok(widget);
  // The definition node is the class_declaration; the `export` keyword lives on the
  // parent export_statement, so the header signature does not include it. The body
  // brace and everything after it are excluded.
  assert.equal(widget.signature, 'class Widget extends Base implements IThing');
  assert.equal(widget.precisionTier, 'tree-sitter');
  assert.ok(!widget.signature.includes('doThing'), 'signature must not include the body');

  // The header is the signature up to the body brace.
  const topFn = defs.find((d) => d.symbol === 'topFn');
  assert.equal(topFn?.signature, 'function topFn(a: number, b: string): string');
});

test('signatures keep generics, object-typed params, and object const values', async () => {
  const defs = await defsFor(
    'typescript',
    [
      'export function process<T extends { id: string }>(x: { a: number }): void {}',
      'export const config = { a: 1, b: 2 };',
      'export type Result<T extends { id: string }> = { ok: true; value: T };',
      'export const arrow = (x: { id: number }): number => x.id;',
    ].join('\n'),
  );
  const sig = (n: string) => defs.find((d) => d.symbol === n)?.signature;
  // The body brace inside a type annotation / object value must NOT truncate.
  assert.equal(sig('process'), 'function process<T extends { id: string }>(x: { a: number }): void');
  assert.equal(sig('config'), 'export const config = { a: 1, b: 2 };');
  assert.equal(sig('Result'), 'type Result<T extends { id: string }> = { ok: true; value: T };');
  assert.equal(sig('arrow'), 'arrow = (x: { id: number }): number => x.id');
});

test('JS extraction yields function/class/method', async () => {
  const defs = await defsFor('javascript', 'export function f(a){return a}\nexport const g = (x) => x;\nclass C { m(){} }\n');
  const kinds = new Map(defs.map((d) => [d.symbol, d.kind]));
  assert.equal(kinds.get('f'), 'function');
  assert.equal(kinds.get('g'), 'function');
  assert.equal(kinds.get('C'), 'class');
  assert.equal(kinds.get('m'), 'method');
});
