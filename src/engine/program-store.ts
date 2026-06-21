import ts from 'typescript';
import { dirname, join, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';

// One built TypeScript project: a LanguageService + its Program/TypeChecker. The
// service is needed (not just the Program) because getImplementationAtPosition and
// findReferences live on the LanguageService — and the impl hop is what resolves
// DI method dispatch to a concrete in-repo method (validated in Phase 0).
export interface PreciseProject {
  configPath: string; // the governing tsconfig, root-relative
  service: ts.LanguageService;
  program: ts.Program;
  checker: ts.TypeChecker;
}

// Lazily builds and caches a TypeScript LanguageService per governing tsconfig.
// NEVER constructed in the server's startup sync — the build is seconds-scale and
// is paid on first precise request, then cached by config path. Local-only: the
// compiler reads config/lib/source files from disk via ts.sys; it makes no network
// calls (the hard guarantee survives).
export class ProgramStore {
  private readonly projects = new Map<string, PreciseProject>(); // configPath -> project
  private readonly parsedConfigs = new Map<string, ts.ParsedCommandLine | undefined>();
  private readonly host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
  };

  constructor(private readonly root: string) {}

  // Drop all cached projects so the next forFile rebuilds against current source.
  // Called when the tree-sitter index reports changed/removed files — otherwise the
  // cached Program (a process-lifetime snapshot) would resolve a fresh def line
  // against stale code and present an OLD call graph as compiler-exact.
  invalidate(): void {
    this.projects.clear();
    this.parsedConfigs.clear();
  }

  // Build/cache the project whose tsconfig governs `absFile`. Returns undefined if
  // no tsconfig includes the file (e.g. a non-TS repo).
  forFile(absFile: string): PreciseProject | undefined {
    const configPath = this.findConfig(absFile);
    if (!configPath) return undefined;
    const cached = this.projects.get(configPath);
    if (cached) return cached;
    const parsed = this.parseConfig(configPath);
    if (!parsed || parsed.fileNames.length === 0) return undefined;
    const project = this.build(configPath, parsed);
    this.projects.set(configPath, project);
    return project;
  }

  // ts speaks absolute, forward-slashed fileNames; the rest of arcscope keys on
  // root-relative-posix. This is the path-identity contract — call-graph nodes must
  // be mergeable with the tree-sitter index by string identity.
  relPath(absFile: string): string {
    const r = relative(this.root, absFile);
    return sep === '/' ? r : r.split(sep).join('/');
  }

  private build(configPath: string, parsed: ts.ParsedCommandLine): PreciseProject {
    const fileNames = parsed.fileNames;
    const options: ts.CompilerOptions = { ...parsed.options, disableSourceOfProjectReferenceRedirect: true };
    const lsHost: ts.LanguageServiceHost = {
      getScriptFileNames: () => fileNames,
      getScriptVersion: () => '1', // static program; rebuilt on demand (no incremental yet)
      getScriptSnapshot: (f) => {
        const text = ts.sys.readFile(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    const service = ts.createLanguageService(lsHost, ts.createDocumentRegistry());
    const program = service.getProgram();
    if (!program) throw new Error(`arcscope: failed to build TS program for ${configPath}`);
    return { configPath: this.relPath(configPath), service, program, checker: program.getTypeChecker() };
  }

  // Walk up from the file's directory to the root; at each level try the configs
  // that actually carry source (Nx splits app/lib includes out of the solution
  // tsconfig.json), and return the first whose fileNames includes the focus file.
  private findConfig(absFile: string): string | undefined {
    const target = normalize(absFile);
    let dir = dirname(absFile);
    for (;;) {
      for (const name of ['tsconfig.app.json', 'tsconfig.lib.json', 'tsconfig.json']) {
        const p = join(dir, name);
        if (!existsSync(p)) continue;
        const parsed = this.parseConfig(p);
        if (parsed && parsed.fileNames.some((f) => normalize(f) === target)) return p;
      }
      const up = dirname(dir);
      if (up === dir || dir === this.root) break;
      dir = up;
    }
    return undefined;
  }

  private parseConfig(configPath: string): ts.ParsedCommandLine | undefined {
    if (this.parsedConfigs.has(configPath)) return this.parsedConfigs.get(configPath);
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      { disableSourceOfProjectReferenceRedirect: true },
      this.host,
    );
    this.parsedConfigs.set(configPath, parsed);
    return parsed;
  }
}

function normalize(p: string): string {
  const fwd = p.split(sep).join('/');
  return ts.sys.useCaseSensitiveFileNames ? fwd : fwd.toLowerCase();
}
