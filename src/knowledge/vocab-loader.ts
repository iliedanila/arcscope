import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { Concept, Locator, Stage, Vocabulary } from './types.js';

// Load and validate .arcscope/vocab.yaml. The file is hand-authored and committed
// (the repo's declared knowledge), so we fail loud on a malformed shape rather than
// silently dropping concepts. Returns an empty vocabulary if the file is absent.
export function loadVocabulary(vocabPath: string): Vocabulary {
  if (!existsSync(vocabPath)) return { concepts: [] };
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(vocabPath, 'utf8'));
  } catch (err) {
    throw new Error(`vocab.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const conceptsObj = isRecord(raw) && isRecord(raw['concepts']) ? raw['concepts'] : {};
  const concepts: Concept[] = [];
  for (const [id, value] of Object.entries(conceptsObj)) {
    concepts.push(parseConcept(id, value));
  }
  return { concepts };
}

function parseConcept(id: string, value: unknown): Concept {
  if (!isRecord(value)) throw new Error(`concept "${id}" must be a mapping`);
  const locators = value['locators'];
  const stages = value['stages'];
  const concept: Concept = {
    id,
    title: typeof value['title'] === 'string' ? value['title'] : id,
    description: typeof value['description'] === 'string' ? value['description'] : undefined,
    note: typeof value['note'] === 'string' ? value['note'] : undefined,
  };
  if (Array.isArray(stages)) {
    concept.stages = stages.map((s, i) => parseStage(id, i, s));
  } else if (Array.isArray(locators)) {
    concept.locators = locators.map((l, i) => parseLocator(`${id}.locators[${i}]`, l));
  } else {
    throw new Error(`concept "${id}" must have a "locators" or "stages" list`);
  }
  return concept;
}

function parseStage(conceptId: string, i: number, value: unknown): Stage {
  if (!isRecord(value) || typeof value['title'] !== 'string') {
    throw new Error(`concept "${conceptId}" stage ${i} must be a mapping with a "title"`);
  }
  return { ...parseLocator(`${conceptId}.stages[${i}]`, value), title: value['title'] };
}

function parseLocator(where: string, value: unknown): Locator {
  if (!isRecord(value)) throw new Error(`${where} must be a mapping`);
  const inGlob = typeof value['in'] === 'string' ? value['in'] : undefined;
  if (value['kind'] === 'symbol') {
    if (typeof value['query'] !== 'string') throw new Error(`${where} (symbol) needs a "query" string`);
    return { kind: 'symbol', query: value['query'], in: inGlob };
  }
  if (value['kind'] === 'path') {
    if (typeof value['glob'] !== 'string') throw new Error(`${where} (path) needs a "glob" string`);
    return { kind: 'path', glob: value['glob'], in: inGlob };
  }
  if (value['kind'] === 'import') {
    if (typeof value['of'] !== 'string') throw new Error(`${where} (import) needs an "of" module-specifier string`);
    return { kind: 'import', of: value['of'], in: inGlob };
  }
  throw new Error(`${where} has unknown kind ${JSON.stringify(value['kind'])} (v1 supports: symbol, path, import)`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
