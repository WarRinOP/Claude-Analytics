// Contract: the typed facts the classifier emits for one JSONL line.
// Facts carry counts, ids, timestamps, model names, tool names and paths only, never content.

export interface LineContext {
  sessionIdFromFile: string; // session id derived from the file path
  isSubagentFile: boolean;
  agentIdFromFile: string | null; // from agent-<id>.jsonl, else null
}

// Common line attributes copied from the record when present.
export interface LineMeta {
  sessionId: string; // record sessionId, falling back to ctx.sessionIdFromFile
  ts: number; // UTC epoch ms parsed from `timestamp`
  isSidechain: boolean;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  entrypoint: string | null;
}

export interface ToolUse {
  id: string;
  name: string;
}

export interface UsageFact extends LineMeta {
  kind: 'usage';
  key: string; // message.id + '|' + requestId, or message.id when requestId is missing
  uuid: string | null;
  agentId: string | null; // record agentId, else ctx.agentIdFromFile
  isSubagentFile: boolean;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number; // cache_creation_input_tokens
  cacheWrite5m: number;
  cacheWrite1h: number;
  thinking: number;
  webSearch: number;
  webFetch: number;
  stopReason: string | null;
  serviceTier: string | null;
  speed: string | null;
  inferenceGeo: string | null; // usage.inference_geo ('global', 'us', 'not_available'); 'us' costs 1.1x
  rank: number; // RANK_STOP_BONUS if stopReason != null, plus output tokens
  toolUses: ToolUse[]; // tool_use blocks: id and name only, never input
  missingFields: string[]; // numeric usage fields that were absent and defaulted to 0
}

export const RANK_STOP_BONUS = 1_000_000_000_000;

export interface MessageFact extends LineMeta {
  kind: 'message';
  uuid: string;
  messageKind: 'prompt' | 'tool_result' | 'meta' | 'compact_summary';
}

export interface ApiErrorFact {
  kind: 'api_error';
  uuid: string;
  sessionId: string;
  ts: number;
}

export interface CompactionFact {
  kind: 'compaction';
  uuid: string;
  sessionId: string;
  ts: number;
  trigger: string | null; // compactMetadata.trigger
  preTokens: number | null; // compactMetadata.preTokens
}

export interface CostModelUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

// cost-state lines have no timestamp. The snapshot with the larger totalDuration wins
// (durations are non decreasing per session), so the outcome does not depend on read order.
export interface CostSnapshotFact {
  kind: 'cost_snapshot';
  sessionId: string;
  startTime: number | null;
  totalDuration: number;
  totalCostUSD: number | null;
  modelUsage: Record<string, CostModelUsage>;
}

export interface SessionTitleFact {
  kind: 'session_title';
  sessionId: string;
  source: 'ai' | 'custom'; // custom titles take precedence over ai titles
  title: string;
}

export interface UnknownTypeFact {
  kind: 'unknown_type';
  type: string; // record type name, or '(missing)'
  version: string | null;
}

// Known record types and subtypes that carry nothing the ledger needs.
export interface IgnoredFact {
  kind: 'ignored';
  reason: string; // for example 'type:attachment', 'system:stop_hook_summary', 'assistant:no_key'
}

// A line that cannot be used: bad JSON, not an object, or a required field unusable.
// `error` is a short description written by us, never text from the line.
export interface MalformedFact {
  kind: 'malformed';
  error: string;
}

export type Fact =
  | UsageFact
  | MessageFact
  | ApiErrorFact
  | CompactionFact
  | CostSnapshotFact
  | SessionTitleFact
  | UnknownTypeFact
  | IgnoredFact
  | MalformedFact;
