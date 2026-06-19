import { Query } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import { extname } from 'node:path';
import type { GrammarRegistry } from './grammar-registry.js';
import type { RefKind } from './types.js';

export interface Occurrence {
  file: string;
  line: number;
  column: number;
  snippet: string;
  refKind: RefKind;
}

// Compiled once per grammar — every value/type identifier node.
const refsQueryCache = new Map<string, Query>();

// Parents where the matching identifier is the *name being declared*, not a
// reference — excluded so a definition doesn't report itself.
const DECL_NAME_PARENTS = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'method_definition',
  'variable_declarator',
  'internal_module',
  'module',
]);

// Re-parse one file and find every reference to `localName` (value or type
// position), classified by refKind. Used by find_refs only on the files the
// import graph says actually import the symbol — so this never runs repo-wide.
export async function findOccurrences(
  registry: GrammarRegistry,
  rel: string,
  source: string,
  localName: string,
): Promise<Occurrence[]> {
  const grammar = await registry.getForExt(extname(rel));
  if (!grammar) return [];
  const parser = await registry.ensureInit();
  parser.setLanguage(grammar.language);
  const tree = parser.parse(source);
  if (!tree) return [];
  try {
    let query = refsQueryCache.get(grammar.id);
    if (!query) {
      query = new Query(grammar.language, '[(identifier) (type_identifier)] @id');
      refsQueryCache.set(grammar.id, query);
    }
    const lines = source.split('\n');
    const out: Occurrence[] = [];
    for (const cap of query.captures(tree.rootNode)) {
      const node = cap.node;
      if (node.text !== localName || isDeclarationName(node)) continue;
      out.push({
        file: rel,
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        snippet: (lines[node.startPosition.row] ?? '').trim().slice(0, 120),
        refKind: classify(node),
      });
    }
    return out;
  } finally {
    tree.delete();
  }
}

// web-tree-sitter returns fresh Node wrappers per access, so compare by position.
function isDeclarationName(node: Node): boolean {
  const p = node.parent;
  return !!p && DECL_NAME_PARENTS.has(p.type) && p.childForFieldName('name')?.startIndex === node.startIndex;
}

function classify(node: Node): RefKind {
  if (node.type === 'type_identifier') return 'type';
  const p = node.parent;
  if (!p) return 'identifier';
  if (p.type === 'call_expression' && p.childForFieldName('function')?.startIndex === node.startIndex) return 'call';
  if (p.type === 'new_expression' && p.childForFieldName('constructor')?.startIndex === node.startIndex) return 'new';
  if (p.type === 'member_expression' && p.childForFieldName('object')?.startIndex === node.startIndex) return 'access';
  if (p.type === 'import_specifier' || p.type === 'namespace_import' || p.type === 'import_clause') return 'import';
  if (p.type === 'extends_clause' || p.type === 'class_heritage' || p.type === 'implements_clause') return 'extends';
  return 'identifier';
}
