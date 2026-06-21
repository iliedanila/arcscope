export interface UsageRecord {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface UsageSummary {
  total: number;
  firstTs?: string;
  lastTs?: string;
  byTool: Record<string, number>;
  topSymbols: { symbol: string; count: number }[];
  topConcepts: { concept: string; count: number }[];
  topEntries: { entry: string; count: number }[];
}

export function parseUsageJsonl(raw: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      const row = parsed as Record<string, unknown>;
      if (typeof row.ts !== 'string' || typeof row.tool !== 'string') continue;
      const args = row.args && typeof row.args === 'object' && !Array.isArray(row.args) ? (row.args as Record<string, unknown>) : {};
      records.push({ ts: row.ts, tool: row.tool, args });
    } catch {
      // skip malformed lines — stats should be resilient to partial writes
    }
  }
  return records;
}

function topCounts(map: Map<string, number>, limit = 5): { key: string; count: number }[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const byTool: Record<string, number> = {};
  const symbols = new Map<string, number>();
  const concepts = new Map<string, number>();
  const entries = new Map<string, number>();

  for (const r of records) {
    byTool[r.tool] = (byTool[r.tool] ?? 0) + 1;
    if (typeof r.args.symbol === 'string') {
      symbols.set(r.args.symbol, (symbols.get(r.args.symbol) ?? 0) + 1);
    }
    if (typeof r.args.concept === 'string') {
      concepts.set(r.args.concept, (concepts.get(r.args.concept) ?? 0) + 1);
    }
    if (typeof r.args.entry === 'string') {
      entries.set(r.args.entry, (entries.get(r.args.entry) ?? 0) + 1);
    }
  }

  const tops = topCounts(symbols);
  return {
    total: records.length,
    firstTs: records[0]?.ts,
    lastTs: records[records.length - 1]?.ts,
    byTool,
    topSymbols: tops.map(({ key, count }) => ({ symbol: key, count })),
    topConcepts: topCounts(concepts).map(({ key, count }) => ({ concept: key, count })),
    topEntries: topCounts(entries).map(({ key, count }) => ({ entry: key, count })),
  };
}
