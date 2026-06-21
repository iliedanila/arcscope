import type { Tree, Node } from 'web-tree-sitter';

// A function's STRUCTURAL fingerprint: a set of k-gram hashes over the sequence of
// AST node *types* in its subtree. Because only node types are emitted (never the
// identifier text or literal values), the fingerprint is name-independent — a
// hand-mirrored re-implementation with every symbol renamed produces the same
// shape. This is what lets discovery catch a clone that shares no name, import, or
// path with the canonical implementation (the case name-matching misses).
export interface FunctionFingerprint {
  name: string; // best-effort, for reporting only — matching ignores it
  line: number; // 1-based
  tokenCount: number; // structural size (a weak relevance/size signal)
  shingles: number[]; // sorted, unique k-gram hashes
}

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
  'arrow_function',
  'method_definition',
]);

// k-gram (shingle) length over the node-type sequence. Validated on the dogfood:
// K=5 was too brittle — realistic divergence (type annotations, `??` vs `||`, one
// extra statement) shatters the 5-grams, so an obvious hand-mirrored clone scored
// ~0.3-0.5 and was silently missed at any safe threshold. K=3 lifts diverged clones
// to a usable band while keeping unrelated code well separated.
const K = 3;
const MIN_TOKENS = 20; // skip trivial functions — too small to match meaningfully

// Fingerprint every function-like node in an already-parsed tree. The caller owns
// the tree (we never call tree.delete()). Nested functions are fingerprinted too.
export function fingerprintTree(tree: Tree): FunctionFingerprint[] {
  const out: FunctionFingerprint[] = [];
  walk(tree.rootNode, out);
  return out;
}

function walk(node: Node, out: FunctionFingerprint[]): void {
  if (FUNCTION_NODE_TYPES.has(node.type)) {
    const fp = fingerprintFunction(node);
    if (fp) out.push(fp);
  }
  for (const c of node.namedChildren) walk(c, out);
}

function fingerprintFunction(node: Node): FunctionFingerprint | null {
  const types: string[] = [];
  collectTypes(node, types);
  if (types.length < MIN_TOKENS) return null;
  const shingles = shingleHashes(types, K);
  if (shingles.length === 0) return null;
  return { name: nameOf(node), line: node.startPosition.row + 1, tokenCount: types.length, shingles };
}

// Pre-order sequence of named node TYPES. Emitting the type (not node.text) is what
// drops identifier names and literal values, leaving only structure.
function collectTypes(node: Node, out: string[]): void {
  out.push(node.type);
  for (const c of node.namedChildren) collectTypes(c, out);
}

function shingleHashes(tokens: string[], k: number): number[] {
  const set = new Set<number>();
  if (tokens.length < k) {
    set.add(hashStr(tokens.join('')));
  } else {
    for (let i = 0; i + k <= tokens.length; i++) set.add(hashStr(tokens.slice(i, i + k).join('')));
  }
  return [...set].sort((a, b) => a - b);
}

// FNV-1a 32-bit — deterministic, fast, local. No crypto strength needed.
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function nameOf(node: Node): string {
  const direct = node.childForFieldName('name')?.text;
  if (direct) return direct;
  // arrow/function expression assigned to a name: const f = () => {} / { key() {} }
  const p = node.parent;
  const viaParent = p?.childForFieldName('name')?.text ?? p?.childForFieldName('key')?.text;
  if (viaParent) return viaParent;
  return `anonymous@${node.startPosition.row + 1}`;
}

// Jaccard similarity over two sorted, unique shingle arrays. 1.0 = identical shape
// (incl. renamed-only clones); 0 = no shared structure.
export function similarity(a: FunctionFingerprint, b: FunctionFingerprint): number {
  const inter = sortedIntersectionSize(a.shingles, b.shingles);
  const union = a.shingles.length + b.shingles.length - inter;
  return union === 0 ? 0 : inter / union;
}

function sortedIntersectionSize(a: number[], b: number[]): number {
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      n++;
      i++;
      j++;
    } else if (a[i]! < b[j]!) {
      i++;
    } else {
      j++;
    }
  }
  return n;
}
