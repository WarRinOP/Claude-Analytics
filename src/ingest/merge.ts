import type { ToolUse, UsageFact } from './facts.ts';

// Merge rules for two lines of one usage key.
// Pure and order independent for lines whose ties carry identical numbers:
// 1. Value columns come from the line with the strictly higher rank. Equal rank keeps the existing values.
// 2. ts is the earliest ts of any line.
// 3. Attribution stays with the first writer, except a main file line replaces a subagent file line.
// 4. Tool uses are the union by id.
export function mergeUsage(existing: UsageFact, incoming: UsageFact): UsageFact {
  const values = incoming.rank > existing.rank ? incoming : existing;
  const attribution = existing.isSubagentFile && !incoming.isSubagentFile ? incoming : existing;
  const seen = new Set<string>();
  const toolUses: ToolUse[] = [];
  for (const t of [...existing.toolUses, ...incoming.toolUses]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    toolUses.push(t);
  }
  return {
    ...values,
    sessionId: attribution.sessionId,
    agentId: attribution.agentId,
    isSidechain: attribution.isSidechain,
    isSubagentFile: attribution.isSubagentFile,
    ts: Math.min(existing.ts, incoming.ts),
    toolUses,
  };
}
