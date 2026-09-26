/**
 * switch — Nintendo Switch play activity, synced from the Parental
 * Controls (znma) API into D1 (`SWITCH_DB`) and served as the versioned
 * view behind lkwplus.com/misc. Artwork is mirrored into R2 at sync time.
 *
 * A sync runs daily on the scheduler (index.ts) and on demand through
 * `POST /switch/sync` (bearer `SWITCH_API_TOKEN`); both call the same
 * `runSync`, which ends by rewriting the snapshot.
 */

import type { Env } from "../../env";
import { isAuthorized, json } from "../../lib/http";
import type { Route } from "../../lib/router";
import type { Service } from "../../lib/service";
import { switchSite } from "./site";
import { runSync } from "./sync";

async function handleSync(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env.SWITCH_API_TOKEN))) {
    return json({ error: "Unauthorized" }, 401);
  }
  try {
    return json(await runSync(env));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 500);
  }
}

const routes: Route[] = [["POST /switch/sync", handleSync]];

export default { name: "switch", site: switchSite, routes } satisfies Service;

export { runSync };
