import type { Tree, Node } from 'web-tree-sitter';
import type { ImportEdge, ImportBinding } from './types.js';

// Extract import + re-export edges from an already-parsed tree by walking the
// top-level statements — import/re-export statements are always top-level in ESM,
// so this is cheap and complete (no full query needed). Verified against real
// barrels in the de-risking spike. The caller owns the tree.
export function extractImports(file: string, tree: Tree): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const node of tree.rootNode.namedChildren) {
    if (node.type === 'import_statement') {
      const edge = fromImport(file, node);
      if (edge) edges.push(edge);
    } else if (node.type === 'export_statement') {
      const edge = fromReExport(file, node);
      if (edge) edges.push(edge);
    }
  }
  return edges;
}

function specifierOf(node: Node): string | null {
  const src = node.childForFieldName('source');
  return src ? src.text.slice(1, -1) : null; // strip quotes
}

function fromImport(file: string, node: Node): ImportEdge | null {
  const specifier = specifierOf(node);
  if (specifier === null) return null;
  const line = node.startPosition.row + 1;
  const clause = node.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return { file, specifier, kind: 'import', star: false, names: [], line }; // side-effect

  const names: ImportBinding[] = [];
  let star = false;
  for (const c of clause.namedChildren) {
    if (c.type === 'identifier') {
      names.push({ imported: 'default', local: c.text }); // default import
    } else if (c.type === 'namespace_import') {
      star = true;
      const id = c.namedChildren.find((x) => x.type === 'identifier');
      if (id) names.push({ imported: '*', local: id.text });
    } else if (c.type === 'named_imports') {
      for (const s of c.namedChildren) {
        if (s.type !== 'import_specifier') continue;
        const n = s.childForFieldName('name');
        if (!n) continue;
        const a = s.childForFieldName('alias');
        names.push({ imported: n.text, local: (a ?? n).text });
      }
    }
  }
  return { file, specifier, kind: 'import', star, names, line };
}

function fromReExport(file: string, node: Node): ImportEdge | null {
  const specifier = specifierOf(node);
  if (specifier === null) return null; // a local `export` declaration, not a re-export edge
  const line = node.startPosition.row + 1;
  const clause = node.namedChildren.find((c) => c.type === 'export_clause');
  if (clause) {
    const names: ImportBinding[] = [];
    for (const s of clause.namedChildren) {
      if (s.type !== 'export_specifier') continue;
      const n = s.childForFieldName('name');
      if (!n) continue;
      const a = s.childForFieldName('alias');
      names.push({ imported: n.text, local: (a ?? n).text }); // local = exported-as name
    }
    return { file, specifier, kind: 're-export', star: false, names, line };
  }
  // `export * from './m'` or `export * as Agg from './m'`
  const ns = node.namedChildren.find((c) => c.type === 'namespace_export');
  const alias = ns?.namedChildren.find((x) => x.type === 'identifier')?.text;
  return {
    file,
    specifier,
    kind: 're-export',
    star: true,
    names: alias ? [{ imported: '*', local: alias }] : [],
    line,
  };
}
