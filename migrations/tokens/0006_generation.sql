-- One counter every write to the tokens data bumps (submissions, quota
-- reports, the wipe), in the same D1 batch as the write itself — see
-- src/services/tokens/state.ts. It is what orders the work around the
-- data, which D1's per-batch transactions alone cannot:
--
--   - a submission reads the device, merges in memory, then writes; the
--     write batch first checks the counter still reads what it read, so
--     two overlapping submissions cannot both merge against the same old
--     state (the later one is rolled back and re-merged instead);
--   - a /tokens/site composition reads it before and after, and a body
--     composed while a write landed is never left as the published one,
--     so an older refresh cannot republish what a wipe just deleted.
--
-- `wiped_generation` is the counter's value at the latest wipe: a raw
-- archive written by a submission committed before it is deleted again.
--
-- A single row, never deleted (the wipe bumps it rather than clearing it,
-- so the counter only ever grows).
CREATE TABLE tokens_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  wiped_generation INTEGER NOT NULL DEFAULT 0
);
INSERT INTO tokens_state (id, generation) VALUES (1, 0);
