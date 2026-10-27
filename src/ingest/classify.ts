// Record classifier: one transcript JSONL line in, exactly one typed fact out.
// Never throws. Never copies message text, thinking, tool inputs or tool results into a fact.
import {
  RANK_STOP_BONUS,
  type Fact,
  type LineContext,
  type LineMeta,
  type CostModelUsage,
  type ToolUse,
  type UsageFact,
  type CostSnapshotFact,
} from './facts.ts';

type Obj = Record<string, unknown>;

const IGNORED_TYPES = new Set([
  'attachment',
  'api-request-blob',
  'api-request',
  'api-request-shape',
  'atis-latch',
  'mode',
  'last-prompt',
  'queue-operation',
  'agent-name',
  'file-history-snapshot',
  'file-history-delta',
  'pr-link',
  'fork-context-ref',
]);

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function count(v: unknown): number | null {
  const n = numOrNull(v);
  return n !== null && n >= 0 ? n : null;
}

// Type, subtype and version names are copied into facts, so keep only tame identifiers.
function tameName(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : '(invalid)';
}

// A short identifier copied from the line (inference_geo), or null when absent or not a tame name.
function tameOrNull(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : null;
}

function malformed(error: string): Fact {
  return { kind: 'malformed', error };
}

function ignored(reason: string): Fact {
  return { kind: 'ignored', reason };
}

function parseTs(rec: Obj): number | null {
  const t = rec['timestamp'];
  if (typeof t !== 'string') return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function sessionIdOf(rec: Obj, ctx: LineContext): string {
  return str(rec['sessionId']) ?? ctx.sessionIdFromFile;
}

function metaOf(rec: Obj, ctx: LineContext, ts: number): LineMeta {
  return {
    sessionId: sessionIdOf(rec, ctx),
    ts,
    isSidechain: rec['isSidechain'] === true,
    cwd: str(rec['cwd']),
    gitBranch: str(rec['gitBranch']),
    version: str(rec['version']),
    entrypoint: str(rec['entrypoint']),
  };
}

function classifyAssistant(rec: Obj, ctx: LineContext): Fact {
  const message = isObj(rec['message']) ? rec['message'] : null;

  if (message?.['model'] === '<synthetic>' || rec['isApiErrorMessage'] === true) {
    const uuid = str(rec['uuid']);
    if (uuid === null) return malformed('missing uuid');
    const ts = parseTs(rec);
    if (ts === null) return malformed('bad timestamp');
    return { kind: 'api_error', uuid, sessionId: sessionIdOf(rec, ctx), ts };
  }

  const usage = message !== null && isObj(message['usage']) ? message['usage'] : null;
  if (message === null || usage === null) return ignored('assistant:no_usage');

  const messageId = str(message['id']);
  if (messageId === null) return ignored('assistant:no_key');
  const requestId = str(rec['requestId']);
  const key = requestId !== null ? `${messageId}|${requestId}` : messageId;

  const ts = parseTs(rec);
  if (ts === null) return malformed('bad timestamp');

  const missingFields: string[] = [];
  const read = (name: string): number => {
    let cur: unknown = usage;
    for (const part of name.split('.')) {
      if (!isObj(cur)) {
        cur = undefined;
        break;
      }
      cur = cur[part];
    }
    const n = count(cur);
    if (n === null) {
      missingFields.push(name);
      return 0;
    }
    return n;
  };

  const input = read('input_tokens');
  const output = read('output_tokens');
  const cacheRead = read('cache_read_input_tokens');
  const cacheWrite = read('cache_creation_input_tokens');
  const cacheWrite5m = read('cache_creation.ephemeral_5m_input_tokens');
  const cacheWrite1h = read('cache_creation.ephemeral_1h_input_tokens');
  const thinking = read('output_tokens_details.thinking_tokens');
  const webSearch = read('server_tool_use.web_search_requests');
  const webFetch = read('server_tool_use.web_fetch_requests');

  const stopReason = str(message['stop_reason']);

  const toolUses: ToolUse[] = [];
  const content = message['content'];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObj(block) || block['type'] !== 'tool_use') continue;
      const id = str(block['id']);
      const name = str(block['name']);
      if (id !== null && name !== null) toolUses.push({ id, name });
    }
  }

  const fact: UsageFact = {
    kind: 'usage',
    ...metaOf(rec, ctx, ts),
    key,
    uuid: str(rec['uuid']),
    agentId: str(rec['agentId']) ?? ctx.agentIdFromFile,
    isSubagentFile: ctx.isSubagentFile,
    model: str(message['model']) ?? '(unknown)',
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite5m,
    cacheWrite1h,
    thinking,
    webSearch,
    webFetch,
    stopReason,
    serviceTier: str(usage['service_tier']),
    speed: str(usage['speed']),
    inferenceGeo: tameOrNull(usage['inference_geo']),
    rank: (stopReason !== null ? RANK_STOP_BONUS : 0) + output,
    toolUses,
    missingFields,
  };
  return fact;
}

function classifyUser(rec: Obj, ctx: LineContext): Fact {
  const uuid = str(rec['uuid']);
  if (uuid === null) return malformed('missing uuid');
  const ts = parseTs(rec);
  if (ts === null) return malformed('bad timestamp');

  const message = isObj(rec['message']) ? rec['message'] : null;
  const content = message?.['content'];
  let messageKind: 'prompt' | 'tool_result' | 'meta' | 'compact_summary' = 'prompt';
  if (rec['isCompactSummary'] === true) messageKind = 'compact_summary';
  else if (rec['isMeta'] === true) messageKind = 'meta';
  else if (Array.isArray(content) && content.some((b) => isObj(b) && b['type'] === 'tool_result')) {
    messageKind = 'tool_result';
  }
  return { kind: 'message', ...metaOf(rec, ctx, ts), uuid, messageKind };
}

function classifySystem(rec: Obj, ctx: LineContext): Fact {
  const subtype = rec['subtype'];
  if (subtype === 'api_error' || subtype === 'compact_boundary') {
    const uuid = str(rec['uuid']);
    if (uuid === null) return malformed('missing uuid');
    const ts = parseTs(rec);
    if (ts === null) return malformed('bad timestamp');
    const sessionId = sessionIdOf(rec, ctx);
    if (subtype === 'api_error') return { kind: 'api_error', uuid, sessionId, ts };
    const cm = isObj(rec['compactMetadata']) ? rec['compactMetadata'] : null;
    return {
      kind: 'compaction',
      uuid,
      sessionId,
      ts,
      trigger: str(cm?.['trigger']),
      preTokens: numOrNull(cm?.['preTokens']),
    };
  }
  return ignored(`system:${tameName(subtype, '(missing)')}`);
}

function classifyCost(rec: Obj, ctx: LineContext): Fact {
  const entries: Array<[string, CostModelUsage]> = [];
  const mu = rec['modelUsage'];
  if (isObj(mu)) {
    for (const [model, raw] of Object.entries(mu)) {
      const u = isObj(raw) ? raw : {};
      entries.push([
        model,
        {
          inputTokens: numOrNull(u['inputTokens']) ?? 0,
          outputTokens: numOrNull(u['outputTokens']) ?? 0,
          thinkingTokens: numOrNull(u['thinkingTokens']) ?? 0,
          cacheReadInputTokens: numOrNull(u['cacheReadInputTokens']) ?? 0,
          cacheCreationInputTokens: numOrNull(u['cacheCreationInputTokens']) ?? 0,
          webSearchRequests: numOrNull(u['webSearchRequests']) ?? 0,
          costUSD: numOrNull(u['costUSD']) ?? 0,
        },
      ]);
    }
  }
  const fact: CostSnapshotFact = {
    kind: 'cost_snapshot',
    sessionId: sessionIdOf(rec, ctx),
    startTime: numOrNull(rec['startTime']),
    totalDuration: numOrNull(rec['totalDuration']) ?? 0,
    totalCostUSD: numOrNull(rec['totalCostUSD']),
    modelUsage: Object.fromEntries(entries), // fromEntries is safe for a "__proto__" model name
  };
  return fact;
}

function classifyRecord(rec: Obj, ctx: LineContext): Fact {
  const type = rec['type'];
  switch (type) {
    case 'assistant':
      return classifyAssistant(rec, ctx);
    case 'user':
      return classifyUser(rec, ctx);
    case 'system':
      return classifySystem(rec, ctx);
    case 'cost-state':
      return classifyCost(rec, ctx);
    case 'ai-title':
    case 'custom-title': {
      const raw = type === 'ai-title' ? rec['aiTitle'] : rec['customTitle'];
      const title = typeof raw === 'string' && raw.trim() !== '' ? raw : null;
      if (title === null) return ignored(`type:${type}`);
      return {
        kind: 'session_title',
        sessionId: sessionIdOf(rec, ctx),
        source: type === 'ai-title' ? 'ai' : 'custom',
        title,
      };
    }
    default:
      break;
  }
  if (typeof type === 'string' && IGNORED_TYPES.has(type)) return ignored(`type:${type}`);
  const version = typeof rec['version'] === 'string' ? rec['version'].slice(0, 32) : null;
  return { kind: 'unknown_type', type: tameName(type, '(missing)'), version };
}

export function classify(line: string, ctx: LineContext): Fact {
  try {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return malformed('invalid json');
    }
    if (!isObj(rec)) return malformed('not an object');
    return classifyRecord(rec, ctx);
  } catch {
    return malformed('classifier error');
  }
}

// cost-state snapshots: the larger totalDuration wins, a tie goes to the later one (b).
export function newerSnapshot(a: CostSnapshotFact, b: CostSnapshotFact): CostSnapshotFact {
  return a.totalDuration > b.totalDuration ? a : b;
}
