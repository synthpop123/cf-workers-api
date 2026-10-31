import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// Fake values for the secrets wrangler.jsonc declares under
// `secrets.required` (the real ones live on the Worker, and in .dev.vars
// for `wrangler dev`). They reach the tests as Miniflare bindings, which
// win over anything wrangler loaded — including a local .dev.vars, so a
// test never runs against a real secret. They are also exported to
// process.env only so wrangler's own required-secrets check passes in CI,
// where there is no .dev.vars and it would warn once per test file.
const TEST_SECRETS = {
  TOKENS_API_TOKEN: "test-token",
  SWITCH_API_TOKEN: "test-switch-token",
  PCTL_SESSION_TOKEN: "test-session-token",
  AIRTRAIL_API_KEY: "test-key",
  GHOSTFOLIO_TOKEN: "test-ghostfolio-token",
  LOGO_DEV_TOKEN: "test-logo-token",
};
Object.assign(process.env, TEST_SECRETS);
// Wrangler then announces where it found them, at info level, once per
// test file. Warnings and errors still come through.
process.env.WRANGLER_LOG ??= "warn";

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
            ...TEST_SECRETS,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
