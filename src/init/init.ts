import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';

// `arcscope init`: index the repo once (the acceptance measurement), register the
// server for the MCP client offline, and ensure local cache files are gitignored.
// init is a human-facing CLI, so writing to stdout here is fine — the stdout
// hygiene rule applies to `serve`'s JSON-RPC stream, not this command.
export async function init(root: string): Promise<void> {
  const out = (s: string) => process.stdout.write(s + '\n');

  // 1. Index pass — measure cold-index time + symbol count on the real tree.
  const store = new IndexStore(root, new GrammarRegistry());
  const stats = await store.sync();
  out(`arcscope: indexed ${stats.fileCount} files, ${stats.symbolCount} symbols in ${stats.elapsedMs}ms`);

  // 2. Registration — point the client at the locally-resolved bin so server
  //    spawn is offline and deterministic (never `npx arcscope serve`). Derive the
  //    bin path from this module (dist/init/init.js -> dist/index.js) rather than
  //    process.argv[1], so it's correct even when invoked via a symlink/wrapper.
  const binPath = fileURLToPath(new URL('../index.js', import.meta.url));
  const mcpPath = join(root, '.mcp.json');
  writeMcpJson(mcpPath, binPath);
  out(`arcscope: wrote ${relative(root, mcpPath) || '.mcp.json'} (node -> ${binPath} serve)`);

  // 3. Keep regenerable local state out of git.
  if (ensureGitignore(root)) out('arcscope: added .arcscope/ to .gitignore');

  out('arcscope: ready — reconnect your MCP client to load the server.');
}

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function writeMcpJson(mcpPath: string, binPath: string): void {
  let config: McpConfig = {};
  if (existsSync(mcpPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(mcpPath, 'utf8'));
      if (parsed && typeof parsed === 'object') config = parsed as McpConfig;
    } catch {
      // unreadable/invalid -> start fresh rather than fail init
    }
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
  config.mcpServers['arcscope'] = { command: 'node', args: [binPath, 'serve'] };
  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export function ensureGitignore(root: string): boolean {
  const p = join(root, '.gitignore');
  const content = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const ignored = content.split('\n').some((l) => {
    const t = l.trim();
    return t === '.arcscope/' || t === '.arcscope';
  });
  if (ignored) return false;
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  const block = `${prefix}\n# arcscope local index/usage cache (regenerable, never committed)\n.arcscope/\n`;
  writeFileSync(p, content + block, 'utf8');
  return true;
}
