import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, dirname } from 'node:path';
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
  const binArg = mcpBinArg(root, binPath);
  const mcpPaths = [join(root, '.mcp.json'), join(root, '.cursor', 'mcp.json')];
  for (const mcpPath of mcpPaths) {
    writeMcpJson(mcpPath, binArg);
    out(`arcscope: wrote ${relative(root, mcpPath)} (node -> ${binArg} serve)`);
  }

  // 3. Keep regenerable local state out of git, but commit the agent-written
  //    knowledge (.arcscope/assertions.yaml) so it travels with the repo.
  if (ensureGitignore(root)) out('arcscope: updated .gitignore (.arcscope/* ignored, assertions.yaml committed)');

  out('arcscope: ready — reload Cursor (or reconnect Claude Code) to load the server.');
}

// Prefer a project-relative bin path when arcscope lives under the repo (e.g.
// node_modules/arcscope/dist/index.js) so committed MCP config is portable.
export function mcpBinArg(root: string, binPath: string): string {
  const rel = relative(root, binPath);
  if (rel && !rel.startsWith('..') && !rel.startsWith('/')) return rel;
  return binPath;
}

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function writeMcpJson(mcpPath: string, binArg: string): void {
  mkdirSync(dirname(mcpPath), { recursive: true });
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
  config.mcpServers['arcscope'] = { command: 'node', args: [binArg, 'serve'] };
  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// Ignore the regenerable local cache (index/usage/anchors) but COMMIT the
// agent-written knowledge — `.arcscope/assertions.yaml` is the repo's declared
// knowledge and must travel with it. Note: re-including a file requires ignoring
// `.arcscope/*` (not the whole `.arcscope/` directory), so an old wholesale ignore
// is upgraded.
export function ensureGitignore(root: string): boolean {
  const p = join(root, '.gitignore');
  const lines = (existsSync(p) ? readFileSync(p, 'utf8') : '').split('\n');
  if (lines.some((l) => l.trim() === '.arcscope/*')) return false; // already in the right shape
  const kept = lines
    .filter((l) => {
      const t = l.trim();
      return t !== '.arcscope/' && t !== '.arcscope' && !/^#\s*arcscope local index/i.test(t);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
  const block =
    '# arcscope: ignore the local cache (index/usage/anchors); commit the knowledge\n.arcscope/*\n!.arcscope/assertions.yaml\n';
  writeFileSync(p, kept ? `${kept}\n\n${block}` : block, 'utf8');
  return true;
}
