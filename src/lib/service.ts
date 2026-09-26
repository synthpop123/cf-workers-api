/**
 * A service is a name that is also its path prefix, the public view it
 * serves, and whatever other routes it answers (its writes, mostly). The
 * view is always served at `GET /<name>/site` from the KV snapshot under
 * `<name>:site`, and every other route sits under `/<name>/` as well
 * (test/services.spec.ts holds both), so a service cannot reach into
 * another's paths or keys.
 */

import type { Route } from "./router";
import { siteHandler, type Snapshot } from "./snapshot";

export interface Service {
  readonly name: string;
  readonly site: Snapshot;
  readonly routes?: readonly Route[];
}

/** Everything a service answers, its view first. */
export function serviceRoutes(service: Service): Route[] {
  return [[`GET /${service.name}/site`, siteHandler(service.site)], ...(service.routes ?? [])];
}
