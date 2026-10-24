/**
 * POST /tokens/quota/:plan — the subscription-quota snapshots behind the
 * tokens page's plan cards: how much of a plan's rate-limit window is
 * spent, when it resets, and how many manual resets are left.
 *
 * The numbers come from the vendors, but no vendor credential ever
 * leaves the machine that holds it. One collector (OracleARM, the box
 * that already runs `tokens serve`) reports each plan on its own timer:
 *
 *   Codex     `tokens codex status --json`, which reads ~/.codex/auth.json,
 *             refreshes the OAuth token if it must, and asks ChatGPT.
 *   Claude    api.anthropic.com/api/oauth/usage with the OAuth token in
 *             ~/.claude/.credentials.json, refreshed by the collector.
 *   OpenCode  opencode.ai/zen/go/v1/usage with an OpenCode API key kept
 *             in a 0600 file on that host.
 *
 * This Worker sees percentages and timestamps and nothing else — which
 * also means it needs no vendor secrets of its own and no scheduled job.
 *
 * **One provider per request, stored in its own row.** The legs
 * fail independently — an expired Claude credential must not take the
 * Codex card down with it — so each report overwrites only its own
 * `quota_plans` row and each plan carries its own `capturedAt`. A
 * collector that can only reach one vendor still gets to say so about
 * that one. D1 rather than KV: a row is a D1 write, where a KV key cost
 * one of the account's 1,000 daily KV writes on every report on top of
 * the view's, and D1 reads its own writes, so the view composed next
 * sees the plan just stored.
 *
 * Each vendor's body is its own shape and **nothing is passed through**:
 * these are third-party payloads (one of them a third-party CLI's stdout)
 * and /tokens/site is a contract this Worker owns. Narrowing each by hand is
 * what keeps an upstream field rename from silently becoming a homepage
 * change — and it is where the account's identity is dropped, because
 * the endpoint this feeds is public and unauthenticated. The narrowers
 * live with the provider registry (quota-registry.ts); this module is
 * only the route around them.
 */

import { json, isAuthorized } from "../../lib/http";
import { isRecord } from "../../lib/narrow";
import { refresh } from "../../lib/snapshot";
import { QUOTA_PROVIDERS, type QuotaPlan } from "./quota-registry";
import { tokensSite } from "./site";

/**
 * The reported provider rides in the path: `POST /tokens/quota/codex`. It
 * decides which vendor's shape the body is read as, and which key the
 * result overwrites.
 */
export async function handleQuota(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env.TOKENS_API_TOKEN))) {
    return json({ error: "Invalid API token" }, 401);
  }

  const id = new URL(request.url).pathname.split("/").pop() ?? "";
  const known = QUOTA_PROVIDERS.get(id);
  if (!known) {
    const supported = [...QUOTA_PROVIDERS.keys()].join(", ");
    return json({ error: `Unsupported quota provider, expected one of: ${supported}` }, 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!isRecord(body)) return json({ error: "Expected a JSON object" }, 400);

  const narrowed = known.narrow(body);
  if (typeof narrowed === "string") return json({ error: narrowed }, 400);
  // Windows are the whole point of a snapshot, so a body without a
  // usable one is rejected rather than stored as an empty card.
  if (narrowed.windows.length === 0) {
    return json({ error: "Snapshot carries no usable rate-limit window" }, 400);
  }

  const plan: QuotaPlan = {
    provider: known.provider,
    label: known.label,
    // The server clock, never the collector's: `capturedAt` is what the
    // dashboard ages the card by, and a reporter with a skewed clock
    // could otherwise present a stale snapshot as fresh.
    capturedAt: new Date().toISOString(),
    ...narrowed,
  };

  // The view is recomposed before the collector hears "accepted", so the
  // card is live by then — quota is its own write event, exactly like a
  // submission.
  await env.TOKENS_DB.prepare(
    `INSERT INTO quota_plans (provider, body) VALUES (?1, ?2)
     ON CONFLICT (provider) DO UPDATE SET body = excluded.body`
  )
    .bind(plan.provider, JSON.stringify(plan))
    .run();
  await refresh(env, tokensSite);

  return json({ success: true, provider: plan.provider, capturedAt: plan.capturedAt });
}
