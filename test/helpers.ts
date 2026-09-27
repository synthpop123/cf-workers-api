/**
 * Test plumbing. `call` runs the real Worker export against the miniflare-backed bindings,
 * waiting out ctx.waitUntil so KV/R2 fan-out has settled before a test
 * asserts on it.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
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

/**
 * For a test that walks a failure path on purpose: captures console.error
 * so the expected log does not read as a failure in CI output, and returns
 * the spy so the test can assert the failure was in fact logged.
 */
export function captureErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

/**
 * A real image (a 12×18 PNG), for anything that goes through the Images
 * binding: the mirror transforms what it fetches, and bytes that are not
 * an image fail that step.
 */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAwAAAASCAIAAADgy6hbAAAAGUlEQVR4nGM8oWHDQAgwEVQxqmhUEZUVAQA8RwFQ9+p3ggAAAABJRU5ErkJggg=="
  ),
  (char) => char.charCodeAt(0)
);

export const imageResponse = () => new Response(PNG, { headers: { "Content-Type": "image/png" } });
