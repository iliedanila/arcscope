import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { Invariant, Locator } from './types.js';

// What the agent records via arch_assert: a named concept = a binding (member
// locators) + an optional invariant. Never a bare list of files — always locators,
// so it re-resolves live.
export interface AssertionInput {
  id: string;
  title: string;
  description?: string;
  locators?: Locator[];
  must?: Invariant;
  flow?: { entry: string; pathGlob?: string }; // a flow concept (precise tier)
}

// Append/update one assertion in the agent-owned .arcscope/assertions.yaml,
// preserving any other agent concepts. This file is machine-written and committed —
// the single source of the repo's architecture knowledge, re-verified live on read.
export function writeAssertion(root: string, a: AssertionInput): string {
  const path = join(root, '.arcscope', 'assertions.yaml');
  const concepts: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed: unknown = yaml.load(readFileSync(path, 'utf8'));
    if (isRecord(parsed) && isRecord(parsed['concepts'])) {
      for (const [k, v] of Object.entries(parsed['concepts'])) concepts[k] = v;
    }
  }
  concepts[a.id] = clean({
    title: a.title,
    description: a.description,
    flow: a.flow ? clean({ entry: a.flow.entry, pathGlob: a.flow.pathGlob }) : undefined,
    locators: a.locators && a.locators.length > 0 ? a.locators.map(locatorToYaml) : undefined,
    must: a.must
      ? clean({ title: a.must.title, locators: a.must.locators.map(locatorToYaml) })
      : undefined,
  });
  mkdirSync(join(root, '.arcscope'), { recursive: true });
  writeFileSync(path, yaml.dump({ concepts }, { lineWidth: 100 }), 'utf8');
  return path;
}

function locatorToYaml(l: Locator): Record<string, unknown> {
  if (l.kind === 'symbol') return clean({ kind: 'symbol', query: l.query, in: l.in });
  if (l.kind === 'path') return clean({ kind: 'path', glob: l.glob, in: l.in });
  return clean({ kind: 'import', of: l.of, in: l.in });
}

function clean(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
