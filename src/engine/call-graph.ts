import ts from 'typescript';
import type { PreciseProject } from './program-store.js';

// One node in a method-resolved call tree. `children` are the in-repo callees
// (concrete, an overload's implementation, or interface/abstract calls recovered to
// their concrete impl via the LanguageService impl hop). `externalCalls` /
// `unresolvedCalls` count the DISTINCT callees that leave the in-repo graph
// (library/.d.ts) or could not be resolved (any/higher-order) — the honest boundary.
export interface CallNode {
  symbol: string;
  file: string; // root-relative-posix
  line: number; // 1-based, the name line
  precisionTier: 'typescript';
  children: CallNode[];
  externalCalls: number;
  unresolvedCalls: number;
  truncated: boolean; // hit depth/size cap
  recursion: boolean; // this node is its own ancestor (a real cycle)
  seenElsewhere: boolean; // already expanded under another parent (DAG re-convergence) — not re-expanded
}

export interface ClosureOptions {
  maxDepth: number;
  maxNodes: number;
  maxImplsPerCall: number;
  relPath: (absFile: string) => string;
}

export interface ClosureResult {
  root: CallNode;
  nodeCount: number;
  hitCap: boolean;
}

type FnDecl = ts.FunctionLikeDeclaration;
type CallLike = ts.CallExpression | ts.NewExpression;

// Test/mock files are not part of a production flow surface. Treated as the
// boundary (like libraries) so mock/test impls never masquerade as real callees —
// getImplementationAtPosition readily returns them on a DI-heavy Angular target.
const TEST_FILE = /\.(spec|test)\.|\/__(mocks|tests)__\/|\/testing\/|(^|[/._-])mock/i;

// Compute the outgoing call closure from a focus function/method, resolving method
// dispatch through the TypeChecker (overloads via the callee symbol, interface /
// abstract receivers via the LanguageService impl hop, constructors via `new`).
// Bounded by depth and node count.
export function callClosure(proj: PreciseProject, focus: FnDecl, opts: ClosureOptions): ClosureResult {
  const { checker, service, program } = proj;
  const onPath = new Set<string>(); // active ancestors — for true-recursion detection
  const expanded = new Set<string>(); // every node fully expanded once — for DAG re-convergence
  let nodeCount = 0;
  let hitCap = false;

  const keyOf = (d: ts.Node): string => d.getSourceFile().fileName + ':' + d.getStart();

  const newNode = (decl: FnDecl): CallNode => {
    const sf = decl.getSourceFile();
    const nameNode = decl.name ?? decl; // name line, not the decorator line (mirrors find_def)
    return {
      symbol: nameOf(decl),
      file: opts.relPath(sf.fileName),
      line: sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1,
      precisionTier: 'typescript',
      children: [],
      externalCalls: 0,
      unresolvedCalls: 0,
      truncated: false,
      recursion: false,
      seenElsewhere: false,
    };
  };

  const expand = (decl: FnDecl, depth: number): CallNode => {
    const node = newNode(decl);
    const key = keyOf(decl);
    if (onPath.has(key)) {
      node.recursion = true;
      return node;
    }
    if (expanded.has(key)) {
      node.seenElsewhere = true; // already shown in full elsewhere — don't duplicate the subtree
      return node;
    }
    nodeCount++;
    if (depth >= opts.maxDepth || nodeCount >= opts.maxNodes) {
      node.truncated = true;
      hitCap = true;
      return node;
    }
    onPath.add(key);
    expanded.add(key);

    const external = new Set<string>();
    const unresolved = new Set<string>();
    for (const call of callsIn(decl)) {
      const r = resolveCall(call);
      if (r.kind === 'in-repo') {
        for (const t of r.decls.slice(0, opts.maxImplsPerCall)) {
          if (nodeCount >= opts.maxNodes) {
            node.truncated = true;
            hitCap = true;
            break;
          }
          node.children.push(expand(t, depth + 1));
        }
      } else if (r.kind === 'external') external.add(r.key);
      else unresolved.add(r.key);
    }
    node.externalCalls = external.size;
    node.unresolvedCalls = unresolved.size;
    onPath.delete(key);
    return node;
  };

  // Resolve a call/new to its in-repo callee declaration(s), or classify it as
  // leaving the graph (external) or unresolvable.
  type Resolution = { kind: 'in-repo'; decls: FnDecl[] } | { kind: 'external'; key: string } | { kind: 'unresolved'; key: string };
  const resolveCall = (call: CallLike): Resolution => {
    let sig: ts.Signature | undefined;
    try {
      sig = checker.getResolvedSignature(call);
    } catch {
      sig = undefined;
    }
    const decl = sig?.declaration;
    if (!decl || !ts.isFunctionLike(decl)) return { kind: 'unresolved', key: calleeText(call) };
    const sf = decl.getSourceFile();
    if (isExternal(sf)) return { kind: 'external', key: sf.fileName + ':' + decl.getStart() };
    if (hasBody(decl)) return { kind: 'in-repo', decls: [decl] };

    // Body-less in-repo declaration: an overload signature, or an interface/abstract
    // member. (a) the callee symbol's own implementation handles overloaded
    // functions/methods; (b) the impl hop handles interface/abstract dispatch.
    const own = symbolImpl(call.expression);
    if (own) return { kind: 'in-repo', decls: [own] };
    if (ts.isPropertyAccessExpression(call.expression)) {
      const impls = implsOf(call.expression.name);
      if (impls.length > 0) return { kind: 'in-repo', decls: impls };
    }
    return { kind: 'unresolved', key: calleeText(call) };
  };

  const symbolImpl = (callee: ts.Expression): FnDecl | undefined => {
    let sym: ts.Symbol | undefined;
    try {
      sym = checker.getSymbolAtLocation(callee);
    } catch {
      sym = undefined;
    }
    const impl = sym?.declarations?.find((d): d is FnDecl => ts.isFunctionLike(d) && hasBody(d));
    return impl && !isExternal(impl.getSourceFile()) ? impl : undefined;
  };

  const implsOf = (nameNode: ts.Node): FnDecl[] => {
    let locs: readonly ts.ImplementationLocation[] | undefined;
    try {
      locs = service.getImplementationAtPosition(nameNode.getSourceFile().fileName, nameNode.getStart());
    } catch {
      locs = undefined;
    }
    const out: FnDecl[] = [];
    for (const loc of locs ?? []) {
      if (loc.fileName.includes('node_modules') || loc.fileName.endsWith('.d.ts') || TEST_FILE.test(loc.fileName)) continue;
      const sf = program.getSourceFile(loc.fileName);
      if (!sf || isExternal(sf)) continue;
      const fn = enclosingFnWithBody(nodeAtPos(sf, loc.textSpan.start));
      if (fn) out.push(fn);
    }
    return out;
  };

  const isExternal = (sf: ts.SourceFile): boolean =>
    sf.isDeclarationFile || program.isSourceFileFromExternalLibrary(sf) || TEST_FILE.test(sf.fileName);

  return { root: expand(focus, 0), nodeCount, hitCap };
}

// Every call/new expression in a declaration's subtree (incl. nested arrows — part
// of the flow). NewExpression follows constructors.
function callsIn(decl: ts.Node): CallLike[] {
  const out: CallLike[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) out.push(n);
    n.forEachChild(walk);
  };
  decl.forEachChild(walk);
  return out;
}

function hasBody(d: ts.SignatureDeclaration): d is FnDecl {
  return 'body' in d && !!(d as FnDecl).body;
}

function calleeText(call: CallLike): string {
  return (call.expression?.getText() ?? '(call)').slice(0, 40);
}

function nodeAtPos(sf: ts.SourceFile, pos: number): ts.Node {
  let found: ts.Node = sf;
  const walk = (n: ts.Node): void => {
    if (pos >= n.getStart(sf) && pos < n.getEnd()) {
      found = n;
      n.forEachChild(walk);
    }
  };
  sf.forEachChild(walk);
  return found;
}

function enclosingFnWithBody(node: ts.Node | undefined): FnDecl | undefined {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isFunctionLike(cur) && hasBody(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

function nameOf(decl: FnDecl): string {
  if (decl.name && ts.isIdentifier(decl.name)) return decl.name.text;
  const p = decl.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name && ts.isIdentifier(p.name)) {
    return p.name.text;
  }
  if (ts.isConstructorDeclaration(decl) && ts.isClassLike(decl.parent) && decl.parent.name) {
    return `${decl.parent.name.text}.constructor`;
  }
  return '(anonymous)';
}

// Locate the focus function/method by name + 1-based name line within a source file.
export function findFocusDecl(program: ts.Program, absFile: string, line: number, symbol: string): FnDecl | undefined {
  const sf = program.getSourceFile(absFile);
  if (!sf) return undefined;
  let match: FnDecl | undefined;
  const walk = (n: ts.Node): void => {
    if (match) return;
    if (ts.isFunctionLike(n) && hasBody(n)) {
      const nm = nameOf(n);
      if (nm === symbol || nm.endsWith('.' + symbol)) {
        const nameNode = n.name ?? n;
        const nameLine = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1;
        if (nameLine === line) match = n;
      }
    }
    n.forEachChild(walk);
  };
  sf.forEachChild(walk);
  return match;
}
