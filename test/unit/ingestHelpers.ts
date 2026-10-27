import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Synthetic transcript lines shared by the ingest and sync tests. Prompts and tool inputs carry SECRET markers on purpose.

export function usageLine(sid: string, n: number, o: { out?: number; stop?: boolean; ts?: number; tools?: string[]; cwd?: string; subagent?: boolean } = {}): string {
  const ts = new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + (o.ts ?? n) * 1000).toISOString();
  const content = (o.tools ?? []).map((id) => ({ type: 'tool_use', id, name: 'Read', input: { secret: 'SECRET' } }));
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${sid}-${n}-${o.stop === true ? 's' : 'p'}`,
    sessionId: sid,
    timestamp: ts,
    version: '9.9.9',
    entrypoint: 'cli',
    cwd: o.cwd ?? '/work/demo',
    gitBranch: 'main',
    isSidechain: o.subagent === true,
    requestId: `req_${n}`,
    message: {
      id: `msg_${n}`,
      model: 'claude-sonnet-5-5',
      role: 'assistant',
      content,
      stop_reason: o.stop === true ? 'end_turn' : null,
      usage: {
        input_tokens: 10 + n,
        cache_read_input_tokens: 1000 * n,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 },
        output_tokens: o.out ?? 5,
        output_tokens_details: { thinking_tokens: 0 },
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        speed: 'standard',
      },
    },
  });
}

export function userLine(sid: string, id: string, ts: number, extra: Record<string, unknown> = {}, cwd = '/work/demo'): string {
  return JSON.stringify({
    type: 'user',
    uuid: id,
    sessionId: sid,
    timestamp: new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + ts * 1000).toISOString(),
    cwd,
    isSidechain: false,
    message: { role: 'user', content: 'SECRET PROMPT' },
    ...extra,
  });
}

export function put(path: string, lines: string[], trailingNewline = true): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + (trailingNewline && lines.length > 0 ? '\n' : ''));
}

