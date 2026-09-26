/**
 * tokens — self-hosted backend for the `tokens` CLI (missuo/tokens) and
 * the view behind lkwplus.com/tokens.
 *
 * The write path implements the official server's submission contract and
 * merge semantics (per-device, per-day, per-client replace with regression
 * guard, parser-revision floors, authoritative clientManifest coverage).
 * It stores the full usage matrix — (device, date, client, model,
 * provider) x (input, output, cacheRead, cacheWrite, reasoning, messages,
 * cost) — in D1 (`TOKENS_DB`). Each handler module documents its own
 * contract.
 *
 * **The CLI's routes are mounted verbatim.** The CLI joins its base URL
 * with `/api/submit`, `/api/auth/token` and `/api/settings/…`, so with
 * `TOKENS_API_URL=https://api.lkwplus.com/tokens` those land under
 * `/tokens/api/…`. That inner `/api` is the third-party contract's, not
 * this Worker's naming; everything this Worker defines for itself sits
 * directly under `/tokens`.
 *
 * There is exactly one read, and that is the point: `/tokens/site` is the
 * view the dashboard consumes, and this backend has no second consumer to
 * generalize for. A filterable aggregation API once sat here too — 677
 * lines answering questions nobody asked, since the CLI computes them
 * locally. The matrix is still in D1 at full fidelity, reachable by
 * `wrangler d1 execute`, the R2 raw archives and the daily exports; what
 * went away is a public surface with no caller.
 *
 * Every accepted submission rewrites the snapshot and, once per
 * Asia/Shanghai day, exports the usage tables to R2 — submissions are the
 * only write event, so neither needs the scheduler.
 *
 * The writes that are not submissions are the quota reports (`POST
 * /tokens/quota/:plan`, one route per subscription): a collector reads
 * each vendor on the machine that holds that credential and reports the
 * percentages here, so this Worker stores no vendor secret.
 *
 * Not implemented: the browser GitHub OAuth device flow (POST
 * /api/auth/device[/poll]); use `tokens login --token` instead.
 */

import type { Route } from "../../lib/router";
import type { Service } from "../../lib/service";
import { handleQuota } from "./quota";
import { QUOTA_PROVIDERS } from "./quota-registry";
import { tokensSite } from "./site";
import { handleAuthToken, handleDeleteSubmittedData, handleSubmit } from "./submit";

const routes: Route[] = [
  // CLI-facing (bearer token; see submit.ts).
  ["POST /tokens/api/submit", handleSubmit],
  ["DELETE /tokens/api/settings/submitted-data", handleDeleteSubmittedData],
  ["GET /tokens/api/auth/token", handleAuthToken],
  // Reported by the quota collectors (quota.ts). One route per
  // subscription, derived from the provider table so an unknown one 404s
  // here rather than inside the handler.
  ...[...QUOTA_PROVIDERS.keys()].map((id): Route => [`POST /tokens/quota/${id}`, handleQuota]),
];

export default { name: "tokens", site: tokensSite, routes } satisfies Service;
