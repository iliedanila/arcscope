import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMcpJson, ensureGitignore } from './init.js';

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

test('ensureGitignore adds .arcscope/ once and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-init-'));
  try {
    const gi = join(dir, '.gitignore');
    assert.equal(ensureGitignore(dir), true); // created
    assert.match(readFileSync(gi, 'utf8'), /^\.arcscope\/$/m);
    assert.equal(ensureGitignore(dir), false); // already present -> no-op
    const count = readFileSync(gi, 'utf8').split('\n').filter((l) => l.trim() === '.arcscope/').length;
    assert.equal(count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
