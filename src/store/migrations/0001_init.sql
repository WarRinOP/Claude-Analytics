-- Usage Ledger archive schema, version 1.
-- Fact tables are the archive. daily_rollup and hourly_rollup are derived and can be rebuilt.

CREATE TABLE source_files (
  id            INTEGER PRIMARY KEY,
  dev           INTEGER NOT NULL,
  ino           INTEGER NOT NULL,
  path          TEXT NOT NULL,
  project_dir   TEXT NOT NULL,              -- folder name under projects/
  session_id    TEXT NOT NULL,
  agent_id      TEXT,                       -- set for subagent files
  is_subagent   INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  byte_offset   INTEGER NOT NULL DEFAULT 0,
  lines_read    INTEGER NOT NULL DEFAULT 0,
  head_hash     TEXT,
  status        TEXT NOT NULL DEFAULT 'active',   -- active or deleted
  first_seen_at INTEGER NOT NULL,
  last_ingested_at INTEGER,
  deleted_detected_at INTEGER,
  UNIQUE (dev, ino)
);

CREATE TABLE projects (
  project_key   TEXT PRIMARY KEY,           -- the session's starting cwd, or dir:<folder> when no event has a cwd
  project_dir   TEXT NOT NULL,
  display_name  TEXT NOT NULL,              -- basename of cwd, editable later
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE project_aliases (
  alias_dir     TEXT PRIMARY KEY,           -- symlink name under projects/
  target_dir    TEXT NOT NULL,
  seen_at       INTEGER NOT NULL
);

CREATE TABLE sessions (
  session_id    TEXT PRIMARY KEY,
  project_key   TEXT NOT NULL REFERENCES projects(project_key),
  first_ts      INTEGER NOT NULL,
  last_ts       INTEGER NOT NULL,
  entrypoint    TEXT,
  first_version TEXT,
  last_version  TEXT,
  git_branch    TEXT,
  has_subagents INTEGER NOT NULL DEFAULT 0,
  project_ts    INTEGER                     -- ts of the event that supplied project_key, null while it is the dir: fallback
);

CREATE TABLE session_titles (
  session_id    TEXT PRIMARY KEY,           -- no foreign key, a title can be read before its session row exists
  source        TEXT NOT NULL,              -- ai or custom
  title         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE usage_events (
  event_key     TEXT PRIMARY KEY,           -- message.id|requestId
  session_id    TEXT NOT NULL,
  agent_id      TEXT,
  is_sidechain  INTEGER NOT NULL,
  is_subagent_file INTEGER NOT NULL,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id),
  ts            INTEGER NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  web_search_requests INTEGER NOT NULL DEFAULT 0,
  web_fetch_requests INTEGER NOT NULL DEFAULT 0,
  stop_reason   TEXT,
  service_tier  TEXT,
  speed         TEXT,
  version       TEXT,
  entrypoint    TEXT,
  rank          INTEGER NOT NULL            -- merge rule 1, see src/ingest/merge.ts
);
CREATE INDEX ix_usage_ts ON usage_events(ts);
CREATE INDEX ix_usage_session ON usage_events(session_id);
CREATE INDEX ix_usage_model_ts ON usage_events(model, ts);

CREATE TABLE tool_calls (
  tool_use_id   TEXT PRIMARY KEY,
  event_key     TEXT NOT NULL,
  name          TEXT NOT NULL
);
CREATE INDEX ix_tool_calls_event ON tool_calls(event_key);

CREATE TABLE messages (
  uuid          TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL,              -- prompt, tool_result, meta or compact_summary
  is_sidechain  INTEGER NOT NULL,
  attributed_model TEXT                     -- model of the next main thread response, resolved later
);
CREATE INDEX ix_messages_ts ON messages(ts);
CREATE INDEX ix_messages_session ON messages(session_id);

CREATE TABLE api_errors (uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE compactions (uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, trigger TEXT, pre_tokens INTEGER);

CREATE TABLE cost_snapshots (
  session_id    TEXT PRIMARY KEY,           -- latest snapshot only
  start_time    INTEGER,
  total_duration_ms INTEGER,
  total_cost_usd REAL,
  model_usage_json TEXT NOT NULL,
  captured_from_file_id INTEGER
);

CREATE TABLE daily_rollup (                 -- derived, rebuildable
  day           TEXT NOT NULL,              -- YYYY-MM-DD in rollup_tz
  project_key   TEXT NOT NULL,
  model         TEXT NOT NULL,              -- empty string for rows without a model
  sessions_active INTEGER NOT NULL,
  prompts       INTEGER NOT NULL,
  responses     INTEGER NOT NULL,
  tool_calls    INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  PRIMARY KEY (day, project_key, model)
);

CREATE TABLE hourly_rollup (day TEXT, hour INTEGER, prompts INTEGER, responses INTEGER, tokens INTEGER, PRIMARY KEY (day, hour));

CREATE TABLE ingest_runs (id INTEGER PRIMARY KEY, started_at INTEGER, finished_at INTEGER, trigger TEXT,
  files_scanned INTEGER, files_changed INTEGER, lines_read INTEGER, events_upserted INTEGER, errors INTEGER);
CREATE TABLE ingest_errors (id INTEGER PRIMARY KEY, run_id INTEGER, source_file_id INTEGER, line_no INTEGER,
  byte_offset INTEGER, line_length INTEGER, error TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX ix_ingest_errors_file ON ingest_errors(source_file_id);
-- Counters are kept per source file so a reread of one file can replace its own rows.
CREATE TABLE unknown_types (type TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', source_file_id INTEGER NOT NULL, count INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY (type, version, source_file_id));
CREATE TABLE missing_fields (field TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', source_file_id INTEGER NOT NULL, count INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY (field, version, source_file_id));
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- rollup_tz, archive_started_at, coverage notes
