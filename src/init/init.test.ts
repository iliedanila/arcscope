import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMcpJson, ensureGitignore, scaffoldVocab } from './init.js';
import { loadVocabulary } from '../knowledge/vocab-loader.js';

test('writeMcpJson writes an offline node command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-init-'));
  try {
    const mcp = join(dir, '.mcp.json');
    writeMcpJson(mcp, '/abs/dist/index.js');
    const cfg = JSON.parse(readFileSync(mcp, 'utf8'));
    assert.equal(cfg.mcpServers.arcscope.command, 'node');
    assert.deepEqual(cfg.mcpServers.arcscope.args, ['/abs/dist/index.js', 'serve']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMcpJson preserves other servers and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-init-'));
  try {
    const mcp = join(dir, '.mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    writeMcpJson(mcp, '/abs/dist/index.js');
    const cfg = JSON.parse(readFileSync(mcp, 'utf8'));
    assert.equal(cfg.mcpServers.other.command, 'x'); // not clobbered
    assert.equal(cfg.mcpServers.arcscope.command, 'node');

    writeMcpJson(mcp, '/abs/dist/index.js');
    assert.deepEqual(JSON.parse(readFileSync(mcp, 'utf8')), cfg); // idempotent
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMcpJson recovers from malformed existing json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-init-'));
  try {
    const mcp = join(dir, '.mcp.json');
    writeFileSync(mcp, '{ not valid json');
    writeMcpJson(mcp, '/abs/dist/index.js');
    assert.equal(JSON.parse(readFileSync(mcp, 'utf8')).mcpServers.arcscope.command, 'node');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureGitignore ignores the cache but commits vocab.yaml, idempotently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-init-'));
  try {
    const gi = join(dir, '.gitignore');
    assert.equal(ensureGitignore(dir), true);
    const c = readFileSync(gi, 'utf8');
    assert.match(c, /^\.arcscope\/\*$/m);
    assert.match(c, /^!\.arcscope\/vocab\.yaml$/m);
    assert.equal(ensureGitignore(dir), false); // idempotent
    const count = readFileSync(gi, 'utf8').split('\n').filter((l) => l.trim() === '.arcscope/*').length;
    assert.equal(count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffoldVocab writes a starter that loads as an empty (no-fake-concept) vocab', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-init-'));
  try {
    const vocab = join(dir, '.arcscope', 'vocab.yaml');
    assert.equal(scaffoldVocab(vocab), true); // creates .arcscope/ + the file
    // The committed-on-purpose examples are commented out, so a fresh repo starts
    // with zero concepts — and the template must still be valid, parseable YAML.
    assert.deepEqual(loadVocabulary(vocab).concepts, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffoldVocab never clobbers an existing committed vocab', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-init-'));
  try {
    const vocab = join(dir, '.arcscope', 'vocab.yaml');
    scaffoldVocab(vocab);
    writeFileSync(vocab, 'concepts:\n  mine:\n    title: Mine\n    locators:\n      - { kind: path, glob: "src/**" }\n');
    assert.equal(scaffoldVocab(vocab), false); // already present -> left untouched
    assert.deepEqual(
      loadVocabulary(vocab).concepts.map((c) => c.id),
      ['mine'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureGitignore upgrades an old wholesale .arcscope/ ignore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-init-'));
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.arcscope/\n');
    assert.equal(ensureGitignore(dir), true);
    const c = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.ok(!c.split('\n').some((l) => l.trim() === '.arcscope/'), 'old wholesale ignore removed');
    assert.match(c, /^\.arcscope\/\*$/m);
    assert.match(c, /node_modules\//); // unrelated entries preserved
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
