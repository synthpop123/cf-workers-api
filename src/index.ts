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
 *   /misc        the four /misc snapshots in one response
 *   /health      liveness
 *
 * Each service lives in src/services/<name>/ and exports its routes;
 * everything they share — the router, the snapshot store every public
 * view is served from, the image mirror, the HTTP vocabulary — is in
 * src/lib/. `/` is the service page (public/index.html), served by Workers
 * Static Assets before this router runs.
 */

import type { Env } from "./env";
import { json } from "./lib/http";
import { createRouter } from "./lib/router";
import { handleMisc } from "./misc";
import { runScheduled } from "./schedule";
import { flightsRoutes } from "./services/flights";
import { moviesRoutes } from "./services/movies";
import { musicRoutes } from "./services/music";
import { switchRoutes } from "./services/switch";
import { tokensRoutes } from "./services/tokens";

const SERVICES = ["tokens", "switch", "flights", "music", "movies"] as const;

const router = createRouter([
  ...tokensRoutes,
  ...switchRoutes,
  ...flightsRoutes,
  ...musicRoutes,
  ...moviesRoutes,
  ["GET /misc", handleMisc],
  ["GET /health", () => json({ ok: true, services: SERVICES })],
]);

export default {
  fetch: router,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(controller.cron, env));
  },
} satisfies ExportedHandler<Env>;
