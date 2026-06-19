import { Parser } from 'web-tree-sitter';
import type { Language, Query, Node, QueryCapture } from 'web-tree-sitter';
import type { DefRecord } from './types.js';

const DEF_PREFIX = 'definition.';
const SIGNATURE_MAX = 200;

// Parse one file and extract its symbol definitions via the grammar's tags query.
// Pairs each @definition.<kind> capture with its @name; dedupes by (symbol,line),
// preferring a specific kind over the generic `constant` when a binding matches
// more than one pattern (e.g. an exported arrow function is a function, not a
// constant). The tree is dropped immediately after extraction to bound memory.
export function extractDefs(
  parser: Parser,
  language: Language,
  query: Query,
  file: string,
  source: string,
): DefRecord[] {
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) return [];
  try {
    const byKey = new Map<string, DefRecord>();
    for (const match of query.matches(tree.rootNode)) {
      let defCap: QueryCapture | undefined;
      let nameCap: QueryCapture | undefined;
      for (const c of match.captures) {
        if (c.name.startsWith(DEF_PREFIX)) defCap = c;
        else if (c.name === 'name') nameCap = c;
      }
      if (!defCap || !nameCap) continue;

      const symbol = nameCap.node.text;
      // The JS tags exclude constructors via a predicate; web-tree-sitter does not
      // auto-apply it, so honor the intent here.
      if (symbol.length === 0 || symbol === 'constructor') continue;

      const kind = defCap.name.slice(DEF_PREFIX.length);
      const line = nameCap.node.startPosition.row + 1;
      const key = `${symbol}:${line}`;
      // Keep the first match for a (symbol, line), but let a specific kind replace
      // the generic 'constant' — an exported arrow function is a function, not a
      // constant, and both patterns match it.
      const existing = byKey.get(key);
      const newIsMoreSpecific = existing?.kind === 'constant' && kind !== 'constant';
      if (existing && !newIsMoreSpecific) continue;
      byKey.set(key, {
        symbol,
        kind,
        file,
        line,
        signature: signatureOf(defCap.node),
        precisionTier: 'tree-sitter',
      });
    }
    return [...byKey.values()];
  } finally {
    tree.delete();
  }
}

// Honest "signature": the definition's real header text with any block body
// stripped using the AST (the body node's start) — NOT a text search for `{`,
// which truncates generic constraints (`<T extends { id }>`), object-typed params
// (`(x: { a })`), and object const values (`= { a: 1 }`). Definitions with no
// block body (type aliases, ambient signatures, expression-bodied arrows,
// non-function consts) keep their full text. Whitespace is collapsed so a wrapped
// multi-line signature reads on one line; the body is never included. It is the
// real header text, never reconstructed — which beats grep's match line by being
// guaranteed to be the definition.
function signatureOf(node: Node): string {
  const bodyStart = bodyStartIndex(node);
  const text = node.text;
  // web-tree-sitter indices are UTF-16 code units, matching JS string indexing,
  // so this slice is exact even with non-ASCII identifiers before the body.
  const header = bodyStart === null ? text : text.slice(0, bodyStart - node.startIndex);
  return header.replace(/\s+/g, ' ').trim().slice(0, SIGNATURE_MAX);
}

// Source index where the definition's block body begins, or null if it has none.
function bodyStartIndex(node: Node): number | null {
  const body = node.childForFieldName('body');
  if (body) return body.startIndex;
  // An arrow/function assigned to a variable_declarator carries its body on `value`.
  const valueBody = node.childForFieldName('value')?.childForFieldName('body');
  if (valueBody && valueBody.type === 'statement_block') return valueBody.startIndex;
  return null;
}
