-- Usage Ledger archive schema, version 3.
-- Costs are integer nano dollars (billionths of a dollar). usage_events.cost_nanos is NULL while a model has no price
-- ("unpriced", never zero). The values are filled by the application (src/store/costs.ts) at the first start after this
-- migration and whenever meta.price_table_version differs from the price table in src/metrics/prices.ts.
-- activity_rollup is derived: its new columns start at 0 and the rollup is rebuilt when its totals no longer match the facts.

ALTER TABLE usage_events ADD COLUMN cost_nanos INTEGER;

ALTER TABLE activity_rollup ADD COLUMN cost_nanos INTEGER NOT NULL DEFAULT 0;   -- sum of cost_nanos of the priced events in the cell
ALTER TABLE activity_rollup ADD COLUMN unpriced INTEGER NOT NULL DEFAULT 0;     -- usage events in the cell whose model has no price
