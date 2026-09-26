import { applyD1Migrations, env } from "cloudflare:test";

// Isolated storage hands every test an empty D1 snapshot; migrations are
// applied here so tests always see the current schema. Idempotent — the
// helper records applied migrations the same way `wrangler d1 migrations
// apply` does.
await applyD1Migrations(env.TOKENS_DB, env.TEST_TOKENS_MIGRATIONS);
await applyD1Migrations(env.SWITCH_DB, env.TEST_SWITCH_MIGRATIONS);
