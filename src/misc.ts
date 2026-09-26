/**
 * GET /misc — every snapshot lkwplus.com/misc draws, in one response.
 *
 * The page has four live sections, and four endpoints meant four requests
 * racing for the first paint. Here the bundle is assembled from the stored
 * snapshot texts by concatenation — no parse, no re-serialization — so it
 * costs four KV reads and a hash:
 *
 *   {"flights":{…},"movies":{…},"music":{…},"switch":{…}}
 *
 * Each section keeps its own `schemaVersion` and its own decoder on the
 * page. A section with nothing to serve is `null`, which fails only that
 * section there — one upstream being down never blanks the other three.
 *
 * The ETag is derived from the four section ETags, so the bundle 304s
 * exactly when none of them moved, and `Last-Modified` is the newest of
 * their change times.
 */

import type { Env } from "./env";
import { etagMatches, etagOf } from "./lib/http";
import { load, type Snapshot } from "./lib/snapshot";
import { flightsSite } from "./services/flights";
import { moviesSite } from "./services/movies";
import { musicSite } from "./services/music";
import { switchSite } from "./services/switch/site";

const SECTIONS: [name: string, snapshot: Snapshot][] = [
  ["flights", flightsSite],
  ["movies", moviesSite],
  ["music", musicSite],
  ["switch", switchSite],
];

export async function handleMisc(request: Request, env: Env): Promise<Response> {
  const stored = await Promise.all(SECTIONS.map(([, snapshot]) => load(env, snapshot)));
  const text = `{${SECTIONS.map(([name], i) => `"${name}":${stored[i]?.text ?? "null"}`).join(",")}}`;
  const etag = await etagOf(stored.map((entry) => entry?.meta.etag ?? "-").join(","));
  const changedAt = Math.max(0, ...stored.map((entry) => entry?.meta.changedAt ?? 0));

  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    ETag: etag,
    "Last-Modified": new Date(changedAt).toUTCString(),
  };
  if (etagMatches(request, etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { headers });
}
