import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSymbolQuery } from './locator.js';

test('parses kind + name pattern + optional value constraint', () => {
  assert.deepEqual(parseSymbolQuery('interface I*Repository'), {
    kind: 'interface',
    namePattern: 'I*Repository',
    valueConstraint: undefined,
  });
  assert.deepEqual(parseSymbolQuery('class StateReducer'), {
    kind: 'class',
    namePattern: 'StateReducer',
    valueConstraint: undefined,
  });
  assert.deepEqual(parseSymbolQuery('const *_REPOSITORY = InjectionToken'), {
    kind: 'constant', // const -> constant
    namePattern: '*_REPOSITORY',
    valueConstraint: 'InjectionToken',
  });
  assert.deepEqual(parseSymbolQuery('method normalizeElement'), {
    kind: 'method',
    namePattern: 'normalizeElement',
    valueConstraint: undefined,
  });
});

test('rejects malformed queries', () => {
  assert.throws(() => parseSymbolQuery('class')); // no name pattern
  assert.throws(() => parseSymbolQuery(''));
});
