import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleResolver } from './module-resolver.js';

test('resolves relative paths, tsconfig aliases, and rejects external', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-resolve-'));
  try {
    // tsconfig with a comment AND a trailing comma — exercises the tolerant parse.
    writeFileSync(
      join(dir, 'tsconfig.base.json'),
      [
        '{',
        '  // path aliases',
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    "paths": {',
        '      "@app/utils": ["libs/utils/src/index.ts"],',
        '      "@app/*": ["libs/*/src/index.ts"],',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    const files = new Set([
      'libs/utils/src/index.ts',
      'libs/domain/src/index.ts',
      'src/a/b.ts',
      'src/a/helper.ts',
      'src/a/sub/index.ts',
    ]);
    const r = new ModuleResolver(dir, (rel) => files.has(rel));

    assert.equal(r.resolve('src/a/b.ts', './helper'), 'src/a/helper.ts'); // relative, extension added
    assert.equal(r.resolve('src/a/b.ts', './helper.js'), 'src/a/helper.ts'); // NodeNext .js specifier -> .ts
    assert.equal(r.resolve('src/a/b.ts', './sub'), 'src/a/sub/index.ts'); // relative dir -> index
    assert.equal(r.resolve('src/a/b.ts', '@app/utils'), 'libs/utils/src/index.ts'); // exact alias
    assert.equal(r.resolve('src/a/b.ts', '@app/domain'), 'libs/domain/src/index.ts'); // wildcard alias
    assert.equal(r.resolve('src/a/b.ts', '@angular/core'), null); // external -> null
    assert.equal(r.resolve('src/a/b.ts', './nope'), null); // not in the index
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
