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
 *   /now/*       the home page's Now tiles, from the stored
 *                music, movies and tokens views plus Mastodon   (KV)
 *   /misc        the four /misc snapshots in one response
 *   /health      liveness
 *
 * Each service lives in src/services/<name>/ and default-exports a
 * `Service` (lib/service.ts): its name, which is also its path prefix, its
 * public view and its other routes. Everything they share — the router,
 * the snapshot store every view is served from, the image mirror, the HTTP
 * vocabulary — is in src/lib/. `/` is the service page (public/index.html), served by Workers
 * Static Assets before this router runs.
 */

import type { Env } from "./env";
import { json } from "./lib/http";
import { createRouter } from "./lib/router";
import { serviceRoutes } from "./lib/service";
import { handleMisc } from "./misc";
import { runScheduled } from "./schedule";
import { SERVICES } from "./services";

const router = createRouter([
  ...SERVICES.flatMap(serviceRoutes),
  ["GET /misc", handleMisc],
  ["GET /health", () => json({ ok: true, services: SERVICES.map(({ name }) => name) })],
]);

export default {
  fetch: router,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(controller.cron, new Date(controller.scheduledTime), env));
  },
} satisfies ExportedHandler<Env>;
