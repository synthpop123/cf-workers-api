/**
 * cf-workers-api — every backend lkwplus.com reads, in one Worker at
 * api.lkwplus.com.
 *
 *   /tokens/*    AI token usage: the tokens CLI's write path, quota
 *                reports, and the dashboard view          (D1 + KV + R2)
 *   /switch/*    Nintendo Switch play activity             (D1 + KV + R2)
 *   /flights/*   the AirTrail flight map                        (KV)
 *   /music/*     Koito listening history                        (KV)
 *   /movies/*    the Letterboxd diary                      (KV + R2)
 *   /memos/*     Mastodon statuses, photos mirrored        (KV + R2)
 *   /portfolio/* Wealthfolio and Ghostfolio, as returns     (KV + R2)
 *   /now/*       the home page's Now tiles, from the stored
 *                music, movies, tokens and portfolio views      (KV)
 *   /misc        the five /misc snapshots in one response
 *   /health      liveness, and whether each view is as fresh as its
 *                schedule promises
 *
 * Each service lives in src/services/<name>/ and default-exports a
 * `Service` (lib/service.ts): its name, which is also its path prefix, its
 * public view and its other routes. Everything they share — the router,
 * the snapshot store every view is served from, the image mirror, the HTTP
 * vocabulary and the upstream narrowing primitives — is in src/lib/, and
 * what runs on a schedule is in schedule.ts. `/` redirects to the service
 * page, lkwplus.com/api, which lives with the site so it is drawn in the
 * site's design system rather than a copy of it.
 */

import { handleHealth } from "./health";
import { createRouter } from "./lib/router";
import { serviceRoutes } from "./lib/service";
import { handleMisc } from "./misc";
import { runScheduled } from "./schedule";
import { SERVICES } from "./services";

/** Where this Worker is documented: a page of the site it serves. */
const SERVICE_PAGE = "https://lkwplus.com/api";

const router = createRouter([
  ...SERVICES.flatMap(serviceRoutes),
  ["GET /misc", handleMisc],
  ["GET /health", handleHealth],
  ["GET /", () => new Response(null, { status: 302, headers: { Location: SERVICE_PAGE } })],
]);

export default {
  fetch: router,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(controller.cron, new Date(controller.scheduledTime), env));
  },
} satisfies ExportedHandler<Env>;
