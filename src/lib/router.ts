/**
 * One route table for every service. Each service exports its routes as
 * `"METHOD /path"` pairs under its own prefix; `createRouter` joins them
 * and owns everything that is the same for all of them: OPTIONS, the 405
 * that names the methods a known path does take, the 404, the JSON 500
 * for a throw nobody planned, and the CORS header set on every response.
 */

import type { Env } from "../env";
import { CORS_HEADERS, json } from "./http";

export type Handler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
) => Response | Promise<Response>;

export type Route = readonly [route: `${string} /${string}`, handler: Handler];

export function createRouter(routes: readonly Route[]): Handler {
  // A Map, not an object: the key comes from the request, and a plain
  // object would resolve `constructor` off Object.prototype.
  const table = new Map<string, Handler>();
  const methods = new Map<string, string[]>();
  for (const [route, handler] of routes) {
    if (table.has(route)) throw new Error(`Duplicate route: ${route}`);
    table.set(route, handler);
    const [method, path] = route.split(" ");
    methods.set(path, [...(methods.get(path) ?? []), method]);
  }

  const dispatch = (request: Request, env: Env, ctx: ExecutionContext) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    const { pathname } = new URL(request.url);
    const handler = table.get(`${request.method} ${pathname}`);
    if (handler) return handler(request, env, ctx);
    const allow = methods.get(pathname)?.join(", ");
    return allow
      ? json({ error: `Method not allowed, use ${allow}` }, 405, { Allow: allow })
      : json({ error: "Not found" }, 404);
  };

  return async (request, env, ctx) => {
    let response: Response;
    try {
      response = await dispatch(request, env, ctx);
    } catch (error) {
      // Without this an unhandled throw (D1 unreachable, KV timeout)
      // becomes the runtime's own 500 with no CORS headers, which a
      // cross-origin page reads as a CORS failure rather than as "the
      // service is down". The cause goes to Workers Logs.
      console.error("Unhandled error", request.method, new URL(request.url).pathname, error);
      response = json({ error: "Internal error" }, 500);
    }
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      response.headers.set(name, value);
    }
    return response;
  };
}
