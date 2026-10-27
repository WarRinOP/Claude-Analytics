// The metric definitions served by GET /api/definitions. The wording is the source of truth in docs/METRICS.md;
// a test checks that every text below appears there word for word and that every bullet there is listed here.
import type { Definitions } from '../api/types.ts';

export const DEFINITIONS: Definitions['definitions'] = [
  {
    id: 'session',
    term: 'Session',
    text: 'one main transcript file (one `sessionId`) with at least one prompt or response. "Sessions in range" counts sessions with at least one prompt or response in the range. Subagent transcripts belong to their parent session.',
  },
  {
    id: 'prompt',
    term: 'Prompt',
    text: 'a `user` record on the main thread that is not a tool result, not meta and not a compaction summary.',
  },
  {
    id: 'claude-response',
    term: 'Claude response',
    text: 'one unique API response (`message.id` plus `requestId`) on the main thread, excluding client generated error lines (`<synthetic>`).',
  },
  {
    id: 'messages',
    term: 'Messages',
    text: 'prompts plus Claude responses. Not identical to the removed Desktop figure or to `/stats`, which count transcript lines differently.',
  },
  {
    id: 'tokens',
    term: 'Tokens',
    text: 'input plus output plus cache write plus cache read, each counted once per API response, including subagent responses. Cache read tokens are prompt prefix reused from cache; they are counted because the old dashboard and `/stats` count them, and the composition meter shows how much of the total they are.',
  },
  {
    id: 'active-day',
    term: 'Active day',
    text: 'a local calendar day with at least one prompt or response.',
  },
  {
    id: 'peak-hour',
    term: 'Peak hour',
    text: 'the local hour of day with the most messages in the range.',
  },
  {
    id: 'peak-day',
    term: 'Peak day',
    text: 'the date with the most messages.',
  },
  {
    id: 'favorite-model',
    term: 'Favorite model',
    text: 'the model with the most tokens in the range (the `/stats` rule). The Models table also shows response counts.',
  },
  {
    id: 'active-time',
    term: 'Active time',
    text: 'the sum of gaps between consecutive events in a session where the gap is at most 30 minutes.',
  },
  {
    id: 'wall-clock-span',
    term: 'Wall clock span',
    text: 'first to last event, shown in the tooltip, because resumed sessions can span days.',
  },
  {
    id: 'streak',
    term: 'Streak',
    text: 'consecutive active days; the current streak counts back from today, or from yesterday when today has no activity yet.',
  },
  {
    id: 'coverage',
    term: 'Coverage',
    text: 'the archive holds what Claude Code still had on disk on the first ingest and everything after. Claude Code deletes a transcript 30 days after it was last written, so before the first ingest only sessions that were continued later survived: days from the archive start up to 30 days before the first ingest are possibly incomplete, and days before the archive start are unknown, not zero.',
  },
  {
    id: 'api-price-equivalent',
    term: 'API price equivalent',
    text: "what the archived usage would cost at Anthropic's published API list prices on the date shown, per model and in total. Each response is priced once: input, output, cache writes (5 minute and 1 hour) and cache reads at that model's rates. It is not what you paid; a Claude subscription is billed differently. Models without a listed price are counted as price unknown, never as zero.",
  },
];
