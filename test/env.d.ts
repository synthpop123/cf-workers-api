/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Injected by vitest.config.mts, consumed by test/setup.ts. */
      TEST_TOKENS_MIGRATIONS: D1Migration[];
      TEST_SWITCH_MIGRATIONS: D1Migration[];
      /** `triggers.crons` from wrangler.jsonc (schedule.spec.ts). */
      TEST_CRONS: string[];
    }
  }
}

export {};
