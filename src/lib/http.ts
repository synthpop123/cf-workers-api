/**
 * The HTTP vocabulary every service speaks: the calendar, the JSON
 * response, the bearer check, conditional requests, the one CORS header
 * set and the way an upstream is asked.
 */

/** All dates in the system are calendar days in this zone — the one the
 *  collectors run in and the one lkwplus.com buckets every day by. */
export const TIME_ZONE = "Asia/Shanghai";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isoDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today (or `now`'s day) as YYYY-MM-DD in TIME_ZONE. */
export function isoToday(now = new Date()): string {
  return isoDayFormat.format(now);
}

/** Shift a YYYY-MM-DD day by whole days. Pure calendar arithmetic in
 *  UTC, so no zone's DST can skip or repeat a day. */
export function shiftDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** How long any upstream gets to answer. A scheduled job or a sync that
 *  waits on a hung host spends its invocation doing nothing. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** `fetch`, bounded by the upstream timeout unless the caller brings its
 *  own signal. Every outbound request goes through here. */
export function fetchUpstream(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
}

/** `fetchUpstream` that rejects on a non-2xx answer, naming the upstream. */
export async function fetchOk(
  name: string,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await fetchUpstream(input, init);
  if (!response.ok) throw new Error(`${name} answered ${response.status}`);
  return response;
}

/**
 * Every response carries the same static CORS set, applied once by the
 * router — never derived from the request's Origin. Reads are public,
 * cookie-less and browser-cacheable, and an Origin-dependent header on a
 * cacheable response poisons caches: a same-origin fetch of the tokens
 * payload (no Origin header) once cached a variant without CORS, which
 * the browser then reused for lkwplus.com's cross-origin read. A constant
 * header set keeps every response byte-identical for every requester.
 * Writes carry it too; CORS is not authentication, the bearer token is.
 *
 * If-None-Match is allowed so a hand-rolled conditional fetch (which
 * preflights, unlike the browser's own cache revalidation) can use it.
 */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, If-None-Match",
  "Access-Control-Expose-Headers": "ETag, Last-Modified",
};

export function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/**
 * Constant-time bearer check against one service's secret: both sides are
 * hashed to fixed-length digests (so length never leaks) and compared with
 * the runtime's timing-safe primitive. An unset secret rejects everything.
 */
export async function isAuthorized(request: Request, secret: string | undefined): Promise<boolean> {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/);
  if (!match || !secret) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(match[1])),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Strong ETag — SHA-256 of the text, quoted per RFC 9110. */
export async function etagOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

/**
 * Weak comparison (RFC 9110 §8.8.3.2) of If-None-Match against a strong
 * ETag: Cloudflare's edge compression forwards the tag as `W/"…"`, which
 * the browser echoes back, so a strict `===` never matches in production
 * and every revalidation downloads the body.
 */
export function etagMatches(request: Request, etag: string): boolean {
  const inm = request.headers.get("If-None-Match");
  return inm?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag) ?? false;
}
