import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// Tests run inside workerd with real (miniflare-backed) D1/KV/R2 bindings
// read from wrangler.jsonc, so integration tests exercise the same code
// paths as production. Things only Node can read — the migrations, the
// configured cron triggers — are read here and handed in as bindings.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const [tokens, switchPlay, config] = await Promise.all([
        readD1Migrations(path("./migrations/tokens")),
        readD1Migrations(path("./migrations/switch")),
        readFile(path("./wrangler.jsonc"), "utf8"),
      ]);
      const crons = /"crons":\s*(\[[^\]]*\])/.exec(config)?.[1] ?? "[]";
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_TOKENS_MIGRATIONS: tokens,
            TEST_SWITCH_MIGRATIONS: switchPlay,
            TEST_CRONS: JSON.parse(crons),
            // The real secrets live on the Worker (and in .dev.vars
            // locally), never in the repo; tests bring their own.
            TOKENS_API_TOKEN: "test-token",
            SWITCH_API_TOKEN: "test-switch-token",
            PCTL_SESSION_TOKEN: "test-session-token",
            AIRTRAIL_API_KEY: "test-key",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
