-- Usage Ledger archive schema, version 4.
-- usage_events.inference_geo holds usage.inference_geo of the winning line ('global', 'us', 'not_available'), a short tame
-- identifier or NULL. Rows ingested before this migration have NULL, which prices as global; that is correct for this archive
-- because no 'us' line exists in it, and a full ingest (cli ingest --full) fills the column from the transcripts.
-- Stored costs are recomputed at the next start because PRICE_TABLE_VERSION moved to 3.

ALTER TABLE usage_events ADD COLUMN inference_geo TEXT;
