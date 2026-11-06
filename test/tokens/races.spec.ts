/**
 * The orderings a single request's transaction cannot see: an older
 * parser's coverage window, two submissions from one device overlapping
 * between their read and their write, and a refresh or archive started
 * before a wipe landing after it. Each test forces the interleaving by
 * pausing one request at the exact await where the race opens.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { refresh, type Snapshot } from "../../src/lib/snapshot";
import type { SubmissionPayload } from "../../src/services/tokens/payload";
import { tokensSite } from "../../src/services/tokens/site";
import { handleSubmit } from "../../src/services/tokens/submit";
import { AUTH, call, DEVICE_ID, reset, submissionPayload, submit } from "./helpers";

beforeEach(() => reset());

/** Cursor's 2026-07-18 tokens for the test device. */
async function cursorTokens(): Promise<number> {
  const row = await env.TOKENS_DB.prepare(
    `SELECT coalesce(sum(input + output + cache_read + cache_write + reasoning), 0) AS n
     FROM daily_usage WHERE device_id = ?1 AND date = '2026-07-18' AND client = 'cursor'`
  )
    .bind(DEVICE_ID)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The default payload with cursor's day raised by `extra` input tokens. */
function withCursor(extra: number, revision = 3): SubmissionPayload {
  const payload = submissionPayload();
  const day = payload.contributions![0];
  day.clients[0].tokens.input += extra;
  day.clients[0].provenance!.schemaVersion = revision;
  day.totals!.tokens += extra;
  payload.summary!.totalTokens! += extra;
  return payload;
}

/**
 * Runs handleSubmit against an env whose D1 runs `after(n)` once the
 * n-th batch (1 = the device read, 2 = the write) has returned.
 */
async function submitPausing(
  payload: SubmissionPayload,
  after: (batch: number) => Promise<void>
): Promise<Response> {
  const db = env.TOKENS_DB;
  let batches = 0;
  const racing = {
    ...env,
    TOKENS_DB: {
      prepare: (query: string) => db.prepare(query),
      batch: async (statements: D1PreparedStatement[]) => {
        const result = await db.batch(statements);
        await after(++batches);
        return result;
      },
    } as unknown as D1Database,
  } as Env;
  const ctx = createExecutionContext();
  const response = await handleSubmit(
    new Request("https://api.test/tokens/api/submit", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    racing,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const wipe = () => call("/tokens/api/settings/submitted-data", { method: "DELETE", headers: AUTH });

describe("coverage from an older parser", () => {
  it("cannot empty history a newer parser stored", async () => {
    await submit();
    expect(await cursorTokens()).toBe(1000);

    const older = withCursor(0, 2);
    older.clientManifest = {
      schemaVersion: 1,
      clients: [
        {
          client: "cursor",
          parserRevision: 2,
          coverage: { mode: "full", start: "2026-07-01", end: "2026-07-31" },
        },
      ],
    };
    const response = await submit(older);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { warnings?: string[] };
    expect(body.warnings?.some((w) => w.startsWith("Rejected cursor"))).toBe(true);
    expect(await cursorTokens()).toBe(1000);
  });

  it("cannot tombstone a day the submission does not carry", async () => {
    await submit();
    // Only Claude's day is sent; cursor's window would reach its stored day.
    const coverageOnly = submissionPayload();
    coverageOnly.contributions = coverageOnly.contributions!.slice(1);
    coverageOnly.summary = { ...coverageOnly.summary, totalTokens: 500, totalCost: 0.3 };
    coverageOnly.clientManifest = {
      schemaVersion: 1,
      clients: [
        {
          client: "cursor",
          parserRevision: 2,
          coverage: { mode: "full", start: "2026-07-01", end: "2026-07-31" },
        },
      ],
    };
    const response = await submit(coverageOnly);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { warnings?: string[] };
    expect(body.warnings?.some((w) => w.startsWith("Ignored cursor coverage"))).toBe(true);
    expect(await cursorTokens()).toBe(1000);
  });

  it("still lets the same revision replace its own history", async () => {
    await submit();
    const coverageOnly = submissionPayload();
    coverageOnly.contributions = coverageOnly.contributions!.slice(1);
    coverageOnly.summary = { ...coverageOnly.summary, totalTokens: 500, totalCost: 0.3 };
    coverageOnly.clientManifest = {
      schemaVersion: 1,
      clients: [
        {
          client: "cursor",
          parserRevision: 3,
          coverage: { mode: "full", start: "2026-07-01", end: "2026-07-31" },
        },
      ],
    };
    expect((await submit(coverageOnly)).status).toBe(200);
    expect(await cursorTokens()).toBe(0);
  });
});

describe("overlapping submissions from one device", () => {
  it("re-merges the later write against the one that beat it", async () => {
    await submit();
    // A (1,100) reads the 1,000 baseline; B (1,200) lands before A writes.
    const response = await submitPausing(withCursor(100), async (batch) => {
      if (batch === 1) expect((await submit(withCursor(200))).status).toBe(200);
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { warnings?: string[] };
    expect(body.warnings?.some((w) => w.includes("would reduce 1,200 tokens to 1,100"))).toBe(true);
    expect(await cursorTokens()).toBe(1200);
  });
});

describe("work started before a wipe", () => {
  it("does not republish the deleted data", async () => {
    await submit();
    const before = (await env.CACHE.get("tokens:site"))!;

    let reached!: () => void;
    let release!: () => void;
    const composed = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let paused = false;
    const slow: Snapshot = {
      ...tokensSite,
      compose: async (e, today) => {
        const text = await tokensSite.compose(e, today);
        if (!paused) {
          paused = true;
          reached();
          await gate;
        }
        return text;
      },
    };

    const pending = refresh(env, slow);
    await composed; // the old refresh holds a body with the 1,000 tokens
    expect((await wipe()).status).toBe(200);
    release();
    await pending;

    const tokens = (text: string) =>
      (JSON.parse(text) as { ranges: { all: { totals: { tokens: number } } } }).ranges.all.totals
        .tokens;
    expect(tokens(before)).toBe(1500);
    expect(tokens((await env.CACHE.get("tokens:site"))!)).toBe(0);
  });

  it("takes back a raw archive the wipe already passed", async () => {
    const response = await submitPausing(submissionPayload(), async (batch) => {
      if (batch === 2) expect((await wipe()).status).toBe(200);
    });
    expect(response.status).toBe(200);
    expect((await env.TOKENS_ARCHIVE.list({ prefix: "raw/" })).objects).toHaveLength(0);
  });
});
