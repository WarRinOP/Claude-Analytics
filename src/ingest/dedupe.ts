// Batch folding: fewer writes, same result. Pure, no database access.
// Usage facts with the same key are merged with mergeUsage, counters are summed by name and version,
// everything else is passed on as it came. Malformed and ignored facts are dropped here (the caller
// has already recorded malformed ones with their line numbers).
import type {
  ApiErrorFact,
  CompactionFact,
  CostSnapshotFact,
  Fact,
  LineMeta,
  MessageFact,
  SessionTitleFact,
  UsageFact,
} from './facts.ts';
import { mergeUsage } from './merge.ts';

export interface UnknownTypeCount {
  type: string;
  version: string | null;
  count: number;
}

export interface MissingFieldCount {
  field: string;
  version: string | null;
  count: number;
}

export interface FoldedBatch {
  usage: UsageFact[]; // one per key, in order of first appearance
  messages: MessageFact[];
  apiErrors: ApiErrorFact[];
  compactions: CompactionFact[];
  costSnapshots: CostSnapshotFact[];
  titles: SessionTitleFact[];
  unknownTypes: UnknownTypeCount[];
  missingFields: MissingFieldCount[];
  // Session level metadata of main file usage and message facts, with exact duplicates removed.
  // Empty for a subagent file, which never creates or changes a session.
  sessionMetas: LineMeta[];
}

function metaKey(m: LineMeta): string {
  return JSON.stringify([m.sessionId, m.ts, m.cwd, m.gitBranch, m.version, m.entrypoint]);
}

export function foldBatch(facts: readonly Fact[], fromSubagentFile = false): FoldedBatch {
  const usage = new Map<string, UsageFact>();
  const unknown = new Map<string, UnknownTypeCount>();
  const missing = new Map<string, MissingFieldCount>();
  const metas = new Map<string, LineMeta>();
  const out: FoldedBatch = {
    usage: [],
    messages: [],
    apiErrors: [],
    compactions: [],
    costSnapshots: [],
    titles: [],
    unknownTypes: [],
    missingFields: [],
    sessionMetas: [],
  };

  const noteMeta = (m: LineMeta): void => {
    if (fromSubagentFile) return;
    const k = metaKey(m);
    if (!metas.has(k)) metas.set(k, m);
  };

  for (const f of facts) {
    switch (f.kind) {
      case 'usage': {
        const prior = usage.get(f.key);
        usage.set(f.key, prior === undefined ? f : mergeUsage(prior, f));
        for (const field of f.missingFields) {
          const k = JSON.stringify([field, f.version]);
          const cur = missing.get(k);
          if (cur === undefined) missing.set(k, { field, version: f.version, count: 1 });
          else cur.count += 1;
        }
        noteMeta(f);
        break;
      }
      case 'message':
        out.messages.push(f);
        noteMeta(f);
        break;
      case 'api_error':
        out.apiErrors.push(f);
        break;
      case 'compaction':
        out.compactions.push(f);
        break;
      case 'cost_snapshot':
        out.costSnapshots.push(f);
        break;
      case 'session_title':
        out.titles.push(f);
        break;
      case 'unknown_type': {
        const k = JSON.stringify([f.type, f.version]);
        const cur = unknown.get(k);
        if (cur === undefined) unknown.set(k, { type: f.type, version: f.version, count: 1 });
        else cur.count += 1;
        break;
      }
      case 'ignored':
      case 'malformed':
        break;
    }
  }

  out.usage = [...usage.values()];
  out.unknownTypes = [...unknown.values()];
  out.missingFields = [...missing.values()];
  out.sessionMetas = [...metas.values()];
  return out;
}
