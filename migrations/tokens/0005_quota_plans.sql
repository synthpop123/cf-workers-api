-- The subscription quota plans the collectors report (POST
-- /tokens/quota/:plan), one row per provider, overwritten in place.
--
-- Not history: a row is the latest report and nothing else, so the table
-- never grows past the number of providers. It used to be one KV key per
-- provider, which made every report two KV writes (the plan, then the
-- tokens view) against the account's 1,000 a day — more than every
-- submission put together. Here the plan costs a D1 write instead, and
-- because D1 reads its own writes, the view composed right after sees it
-- without any read-your-write workaround.
--
-- `body` is the narrowed plan as /tokens/site ships it (quota-registry.ts),
-- `capturedAt` included; the narrowing happened before it was stored.
CREATE TABLE quota_plans (
  provider TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
