import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
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
  if (ensureGitignore(root)) out('arcscope: updated .gitignore (.arcscope/* ignored, vocab.yaml committed)');

  // 4. Scaffold a commented starter vocabulary for the agent's knowledge layer.
  //    A template, never auto-generated concepts — authoring concepts is the
  //    user's job, and auto-bootstrap stays out of v1.
  const vocabPath = join(root, '.arcscope', 'vocab.yaml');
  if (scaffoldVocab(vocabPath)) {
    out(`arcscope: wrote ${relative(root, vocabPath)} (commented starter — author concepts, then arch_query)`);
  }

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

// Ignore the regenerable local cache (index/usage/anchors) but COMMIT the
// vocabulary — `.arcscope/vocab.yaml` is the repo's declared knowledge and must
// travel with it. Note: re-including a file requires ignoring `.arcscope/*` (not
// the whole `.arcscope/` directory), so an old wholesale ignore is upgraded.
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
    '# arcscope: ignore the local cache (index/usage/anchors); commit the vocabulary\n.arcscope/*\n!.arcscope/vocab.yaml\n';
  writeFileSync(p, kept ? `${kept}\n\n${block}` : block, 'utf8');
  return true;
}

// A fully-commented starter so `arch_list` is empty (no fake concepts, no drift
// noise) until the user authors real ones. Never clobber an existing vocab — it
// is the repo's committed knowledge.
export function scaffoldVocab(vocabPath: string): boolean {
  if (existsSync(vocabPath)) return false;
  mkdirSync(dirname(vocabPath), { recursive: true });
  writeFileSync(vocabPath, STARTER_VOCAB, 'utf8');
  return true;
}

const STARTER_VOCAB = `# .arcscope/vocab.yaml — this repo's architecture vocabulary.
#
# Named concepts, each bound to engine-resolved locators that arcscope answers
# LIVE against the current code, so the answer never goes stale. Commit this
# file; the rest of .arcscope/ is a regenerable local cache and is gitignored.
#
# Locators resolve through arcscope's own tree-sitter engine — NEVER a shell
# command — so a committed manifest can't run code on a teammate's machine.
# Three locator kinds:
#   symbol  query: "<kind> <namePattern> [= <value>]"   in: "<glob>" (optional)
#           kinds: interface | class | function | method | type | enum | const
#           namePattern is a glob over the symbol name, e.g. *Repository
#   path    glob:  "<glob>"                              in: "<glob>" (optional)
#   import  of:    "<module-specifier>"                  in: "<glob>" (optional)
#           every file importing that module (exact or a subpath) — an import
#           boundary; drift flags a new importer the moment it appears
#
# Uncomment an example below, edit it to fit this repo, then run arch_list and
# arch_query <concept>. A concept may use a flat \`locators:\` list or ordered
# \`stages:\` (a pipeline whose steps arch_query reports in order).

concepts:
  # public-api:
  #   title: The package's public surface
  #   description: One-line summary the agent reads before diving into the code.
  #   locators:
  #     - { kind: path,   glob: "src/index.ts" }
  #     - { kind: symbol, query: "interface *Options", in: "src/**" }

  # request-flow:
  #   title: "Layered flow: handler -> service -> repository"
  #   description: Ordered stages — arch_query reports each stage's live location.
  #   stages:
  #     - { title: Handler,    kind: symbol, query: "function handle*",  in: "src/**" }
  #     - { title: Service,    kind: symbol, query: "class *Service",    in: "src/**" }
  #     - { title: Repository, kind: symbol, query: "class *Repository", in: "src/**" }

  # filesystem-boundary:
  #   title: Who imports the filesystem
  #   description: An import boundary — arch_query flags any new file that reaches for fs.
  #   locators:
  #     - { kind: import, of: "node:fs" }
`;
