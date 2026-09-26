/**
 * Runs the real Worker export against the miniflare-backed bindings,
 * waiting out ctx.waitUntil so KV/R2 fan-out has settled before a test
 * asserts on it.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export async function call(
  path: string,
  init?: RequestInit<IncomingRequestCfProperties>
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`https://api.test${path}`, init),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}
