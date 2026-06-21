import ts from 'typescript';
import type { PreciseProject } from './program-store.js';
import type { RefRecord, RefKind } from './types.js';

// Compiler-exact references to a symbol defined at (absFile, nameLine) — INCLUDING
// member access (obj.method()), which the tree-sitter import-resolution tier cannot
// follow. Uses the LanguageService findReferences (the same the IDE uses), so a
// method's call sites resolve through the type checker. Returns [] if the symbol's
// name can't be located in the program (caller falls back to the tree-sitter tier).
export function preciseReferences(
  proj: PreciseProject,
  absFile: string,
  nameLine: number,
  symbol: string,
  relPath: (abs: string) => string,
): RefRecord[] {
  const { service, program } = proj;
  const sf = program.getSourceFile(absFile);
  if (!sf) return [];
  const pos = namePosition(sf, nameLine, symbol);
  if (pos === undefined) return [];

  let groups: readonly ts.ReferencedSymbol[] | undefined;
  try {
    groups = service.findReferences(absFile, pos);
  } catch {
    return [];
  }

  const out: RefRecord[] = [];
  const seen = new Set<string>();
  for (const g of groups ?? []) {
    for (const e of g.references) {
      if (e.isDefinition) continue;
      const refSf = program.getSourceFile(e.fileName);
      if (!refSf || refSf.isDeclarationFile) continue;
      const { line, character } = refSf.getLineAndCharacterOfPosition(e.textSpan.start);
      const file = relPath(e.fileName);
      const key = `${file}:${line + 1}:${character + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        symbol,
        file,
        line: line + 1,
        column: character + 1,
        snippet: lineSnippet(refSf, line),
        refKind: classify(nodeAtPos(refSf, e.textSpan.start)),
        resolved: true,
        resolvesTo: { file: relPath(absFile), line: nameLine },
        precisionTier: 'typescript',
      });
    }
  }
  return out;
}

// Position of the symbol's name identifier on its 1-based definition line.
function namePosition(sf: ts.SourceFile, line: number, symbol: string): number | undefined {
  let pos: number | undefined;
  const walk = (n: ts.Node): void => {
    if (pos !== undefined) return;
    if (ts.isIdentifier(n) && n.text === symbol) {
      const l = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      if (l === line) pos = n.getStart(sf);
    }
    n.forEachChild(walk);
  };
  sf.forEachChild(walk);
  return pos;
}

function lineSnippet(sf: ts.SourceFile, line: number): string {
  const starts = sf.getLineStarts();
  const start = starts[line]!;
  const end = line + 1 < starts.length ? starts[line + 1]! : sf.text.length;
  return sf.text.slice(start, end).trim().slice(0, 120);
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

function classify(node: ts.Node): RefKind {
  const p = node.parent;
  if (!p) return 'identifier';
  if (ts.isCallExpression(p) && p.expression === node) return 'call';
  if (ts.isNewExpression(p) && p.expression === node) return 'new';
  if (ts.isPropertyAccessExpression(p) && p.name === node) {
    const gp = p.parent;
    if (gp && ts.isCallExpression(gp) && gp.expression === p) return 'call';
    if (gp && ts.isNewExpression(gp) && gp.expression === p) return 'new';
    return 'access';
  }
  if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p)) return 'type';
  if (ts.isExpressionWithTypeArguments(p)) return 'extends';
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return 'import';
  return 'identifier';
}
