export interface ParsedSymbolQuery {
  kind: string; // def kind to match (const -> constant)
  namePattern: string; // glob over the symbol name
  valueConstraint?: string; // substring the def signature must contain
}

const KIND_ALIASES: Record<string, string> = { const: 'constant' };

// Parse a symbol locator query: "<kind> <namePattern> [= <valueConstraint>]".
// Examples: "interface I*Repository", "class GraphReducer",
// "const *_REPOSITORY = InjectionToken", "method normalizeElement".
// Pure string parsing — no regex injection, no shell-out (invariant 4).
export function parseSymbolQuery(query: string): ParsedSymbolQuery {
  let head = query.trim();
  let valueConstraint: string | undefined;
  const eq = head.indexOf('=');
  if (eq >= 0) {
    valueConstraint = head.slice(eq + 1).trim() || undefined;
    head = head.slice(0, eq).trim();
  }
  const sp = head.indexOf(' ');
  if (sp < 0) {
    throw new Error(`invalid symbol locator query: "${query}" (expected "<kind> <namePattern> [= <value>]")`);
  }
  const rawKind = head.slice(0, sp).trim();
  const namePattern = head.slice(sp + 1).trim();
  if (rawKind.length === 0 || namePattern.length === 0) {
    throw new Error(`invalid symbol locator query: "${query}" (missing kind or name pattern)`);
  }
  return { kind: KIND_ALIASES[rawKind] ?? rawKind, namePattern, valueConstraint };
}
