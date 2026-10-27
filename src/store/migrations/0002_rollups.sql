-- Usage Ledger archive schema, version 2.
-- The version 1 rollup tables had no project or model columns for hours and carried a sessions count that cannot be
-- added up, so they are replaced by one derived table. It holds no archive data: it is rebuilt from usage_events,
-- messages and sessions whenever the time zone changes or a check at start finds it out of date.

DROP TABLE daily_rollup;
DROP TABLE hourly_rollup;

CREATE TABLE activity_rollup (
  day           TEXT NOT NULL,              -- YYYY-MM-DD in the zone stored in meta.rollup_tz
  hour          INTEGER NOT NULL,           -- local hour 0 to 23
  project_key   TEXT NOT NULL,              -- the session's project_key, empty when the session row is missing
  model         TEXT NOT NULL,              -- usage model, or the attributed model of a prompt; empty when unknown
  is_subagent_file INTEGER NOT NULL,        -- 1 for events read from subagent files (tokens and tool calls only)
  prompts       INTEGER NOT NULL,           -- main thread prompts
  responses     INTEGER NOT NULL,           -- usage events with is_sidechain 0 and is_subagent_file 0
  tool_calls    INTEGER NOT NULL,
  input         INTEGER NOT NULL,
  output        INTEGER NOT NULL,
  cache_read    INTEGER NOT NULL,
  cache_write   INTEGER NOT NULL,
  PRIMARY KEY (day, hour, project_key, model, is_subagent_file)
);
CREATE INDEX ix_activity_day ON activity_rollup(day);
