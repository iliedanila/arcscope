import { Parser, Language, Query } from 'web-tree-sitter';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface LoadedGrammar {
  id: string;
  language: Language;
  query: Query;
}

// Each grammar's tags query is the upstream javascript tags ++ (for TS) the
// upstream typescript tags ++ arcscope's vetted additions (type aliases, enums,
// namespaces, exported consts — forms the stock tags omit). The TS grammar is a
// superset of JS, so the JS patterns compile and match against it; running the TS
// tags alone would miss most real definitions. Verified by the engine tests.
const GRAMMARS: Record<string, { wasm: string; queries: string[] }> = {
  typescript: {
    wasm: 'tree-sitter-typescript.wasm',
    queries: ['javascript-tags.scm', 'typescript-tags.scm', 'arcscope-extra-typescript.scm'],
  },
  tsx: {
    wasm: 'tree-sitter-tsx.wasm',
    queries: ['javascript-tags.scm', 'typescript-tags.scm', 'arcscope-extra-typescript.scm'],
  },
  javascript: {
    wasm: 'tree-sitter-javascript.wasm',
    queries: ['javascript-tags.scm', 'arcscope-extra-javascript.scm'],
  },
};

const EXT_TO_GRAMMAR: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

// The web-tree-sitter WASM runtime is a single global; init it once per process
// regardless of how many GrammarRegistry instances exist (tests create several).
let runtimeInit: Promise<void> | undefined;

// Lazily loads WASM grammars + compiled tag queries from the vendored, offline
// grammar directory. Nothing here touches the network.
export class GrammarRegistry {
  private parser?: Parser;
  private readonly cache = new Map<string, LoadedGrammar>();
  private readonly dir: string;

  constructor(grammarsDir?: string) {
    this.dir = grammarsDir ?? resolveGrammarsDir();
  }

  grammarIdForExt(ext: string): string | undefined {
    return EXT_TO_GRAMMAR[ext];
  }

  async ensureInit(): Promise<Parser> {
    if (!runtimeInit) {
      runtimeInit = Parser.init({ locateFile: (name: string) => join(this.dir, name) });
    }
    await runtimeInit;
    if (!this.parser) this.parser = new Parser();
    return this.parser;
  }

  async getForExt(ext: string): Promise<LoadedGrammar | undefined> {
    const id = EXT_TO_GRAMMAR[ext];
    return id ? this.getGrammar(id) : undefined;
  }

  async getGrammar(id: string): Promise<LoadedGrammar> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    await this.ensureInit();
    const spec = GRAMMARS[id];
    if (!spec) throw new Error(`unknown grammar id: ${id}`);
    const language = await Language.load(new Uint8Array(readFileSync(join(this.dir, spec.wasm))));
    const source = spec.queries.map((q) => readFileSync(join(this.dir, q), 'utf8')).join('\n');
    const loaded: LoadedGrammar = { id, language, query: new Query(language, source) };
    this.cache.set(id, loaded);
    return loaded;
  }
}

// Grammars live in dist/grammars/ in the published package and vendor/grammars/
// in the source tree (tests run against the latter). Prefer the built location.
function resolveGrammarsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = join(here, '..', 'grammars'); // dist/engine -> dist/grammars
  if (existsSync(dist)) return dist;
  const vendor = join(here, '..', '..', 'vendor', 'grammars'); // src/engine -> vendor/grammars
  if (existsSync(vendor)) return vendor;
  throw new Error(
    'arcscope: grammar assets not found (looked in dist/grammars and vendor/grammars). ' +
      'Run `npm run build`, or reinstall the package.',
  );
}
