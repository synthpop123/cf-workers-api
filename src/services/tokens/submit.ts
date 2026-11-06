/**
 * POST /tokens/api/submit — CLI-compatible write path with the official
 * server's merge semantics (see merge.ts). Also implements:
 *   DELETE /tokens/api/settings/submitted-data (tokens delete-submitted-data)
 *   GET    /tokens/api/auth/token             (tokens login --token)
 */

import { json, isAuthorized } from "../../lib/http";
import { ACTIVE_DAYS_SQL, TOKENS_SQL } from "./metrics";
import type { SubmissionPayload } from "./payload";
import {
  normalizePayload,
  validatePayload,
  asNonNegativeInt,
  asNonNegativeNumber,
  LEGACY_DEVICE_KEY,
  LEGACY_DEVICE_NAME,
} from "./payload";
import type { DeviceState, DayState } from "./merge";
import {
  aggregateIncomingDay,
  collectSubmittedClients,
  daysEqual,
  deriveRevisionFloors,
  extractCoverages,
  mergeDay,
  modelKey,
} from "./merge";
import { refresh } from "../../lib/snapshot";
import { tokensSite } from "./site";
import { ensureDailyBackup, wipeArchive } from "./backup";
import { STATE_SQL, bump, bumpForWipe, guard, readState, type TokensState } from "./state";

interface StoredUsageRow {
  date: string;
  client: string;
  model: string;
  provider: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  messages: number;
  cost: number;
  parser_revision: number;
}

interface StoredActivityRow {
  date: string;
  active_time_ms: number;
}

function buildStoredState(rows: StoredUsageRow[]): DeviceState {
  const state: DeviceState = new Map();
  for (const r of rows) {
    let day = state.get(r.date);
    if (!day) {
      day = new Map();
      state.set(r.date, day);
    }
    let client = day.get(r.client);
    if (!client) {
      client = { revision: r.parser_revision, models: new Map() };
      day.set(r.client, client);
    }
    client.revision = Math.max(client.revision, r.parser_revision);
    client.models.set(modelKey(r.model, r.provider), {
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      reasoning: r.reasoning,
      messages: r.messages,
      cost: r.cost,
    });
  }
  return state;
}

/**
 * Set-based writes: changed rows travel as one JSON parameter and are
 * expanded server-side with json_each, so the statement count stays
 * constant no matter how many days a submission changes. D1 caps queries
 * per Worker invocation (50 on the Free plan, counted per statement —
 * splitting into more batches does not reset it), which per-row SQL would
 * exceed on any full-history first upload. `value ->> N` extracts the
 * N-th column of each JSON row.
 */
const INSERT_USAGE_SQL = `
INSERT INTO daily_usage
  (device_id, date, client, model, provider,
   input, output, cache_read, cache_write, reasoning, messages, cost,
   parser_revision)
SELECT ?1,
       value ->> 0, value ->> 1, value ->> 2, value ->> 3,
       value ->> 4, value ->> 5, value ->> 6, value ->> 7,
       value ->> 8, value ->> 9, value ->> 10, value ->> 11
FROM json_each(?2)`;

const DELETE_USAGE_SQL = `
DELETE FROM daily_usage
WHERE device_id = ?1 AND date IN (SELECT value FROM json_each(?2))`;

/** WHERE true disambiguates the upsert clause after INSERT ... SELECT. */
const UPSERT_ACTIVITY_SQL = `
INSERT INTO daily_activity (device_id, date, active_time_ms)
SELECT ?1, value ->> 0, value ->> 1 FROM json_each(?2) WHERE true
ON CONFLICT (device_id, date) DO UPDATE SET
  active_time_ms = excluded.active_time_ms`;

/** Rows per INSERT statement — bounds the JSON parameter comfortably
 *  below D1's 2 MB per-value cap (~120 bytes/row × 5000 ≈ 600 KB). */
const USAGE_ROWS_PER_STATEMENT = 5000;

/** How long the submission audit log keeps a row. Long enough to answer
 *  "is every device still reporting on cadence", short enough that the
 *  table stays flat instead of growing forever (see the DELETE below). */
const AUDIT_RETENTION_DAYS = 30;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One accepted submission, as the write plan and the archive see it. */
interface Submission {
  payload: SubmissionPayload;
  deviceId: string;
  deviceName: string | null;
  submissionId: string;
  receivedAt: number;
}

/** What D1 already holds for the submitting device. */
interface DeviceRecord {
  stored: DeviceState;
  storedActivity: Map<string, number>;
  mode: "create" | "merge";
  /** The write counter as of these rows (state.ts). */
  generation: number;
}

async function loadDevice(env: Env, deviceId: string): Promise<DeviceRecord> {
  // One batch, so one transaction: the counter names exactly these rows.
  const [usageRes, activityRes, stateRes] = await env.TOKENS_DB.batch([
    env.TOKENS_DB.prepare(
      `SELECT date, client, model, provider, input, output, cache_read,
                cache_write, reasoning, messages, cost, parser_revision
         FROM daily_usage WHERE device_id = ?`
    ).bind(deviceId),
    env.TOKENS_DB.prepare(
      `SELECT date, active_time_ms FROM daily_activity WHERE device_id = ?`
    ).bind(deviceId),
    env.TOKENS_DB.prepare(STATE_SQL),
  ]);
  const state = stateRes.results[0] as unknown as TokensState | undefined;
  if (!state) throw new Error("tokens_state is missing its row (migration 0006)");
  const storedRows = usageRes.results as unknown as StoredUsageRow[];
  const stored = buildStoredState(storedRows);
  const storedActivity = new Map<string, number>();
  for (const m of activityRes.results as unknown as StoredActivityRow[]) {
    storedActivity.set(m.date, m.active_time_ms);
  }

  return {
    stored,
    storedActivity,
    mode: storedRows.length === 0 ? "create" : "merge",
    generation: state.generation,
  };
}

/**
 * Merge the submission into the stored state day by day (merge.ts owns the
 * rules). Returns only the days whose stored rows would change, so an
 * unchanged rescan — the common case — plans no usage writes at all.
 * Warnings are appended to the validator's list so the response carries
 * both in one place.
 */
function mergeSubmission(
  payload: SubmissionPayload,
  stored: DeviceState,
  warnings: string[]
): Map<string, DayState> {
  const contributions = payload.contributions ?? [];
  const floors = deriveRevisionFloors(stored);
  const submittedClients = collectSubmittedClients(payload.summary?.clients, contributions);
  const incomingDays = contributions.map((day) => ({
    date: day.date,
    incoming: aggregateIncomingDay(day.clients),
  }));

  // Rejection is decided over the whole submission before anything merges,
  // so the coverage windows below can leave a rejected client's history
  // alone on every day — including days earlier in the list than the one
  // whose rows carried the old revision.
  const rejectedClients = new Set<string>();
  for (const { incoming } of incomingDays) {
    for (const [client, data] of incoming) {
      const floor = floors.get(client) ?? 1;
      if (data.revision < floor && !rejectedClients.has(client)) {
        warnings.push(
          `Rejected ${client}: parser revision ${data.revision} is older than stored revision ${floor}.`
        );
        rejectedClients.add(client);
      }
    }
  }
  const coverages = extractCoverages(payload.clientManifest?.clients, floors, rejectedClients);
  for (const entry of payload.clientManifest?.clients ?? []) {
    const floor = floors.get(entry?.client) ?? 1;
    if (entry?.coverage && !rejectedClients.has(entry.client) && !(entry.parserRevision >= floor)) {
      warnings.push(
        `Ignored ${entry.client} coverage: parser revision ${entry.parserRevision} is older than stored revision ${floor}.`
      );
    }
  }

  const changedDays = new Map<string, DayState>();
  const incomingDates = new Set<string>();

  for (const { date, incoming } of incomingDays) {
    incomingDates.add(date);
    const { merged, warnings: dayWarnings } = mergeDay(
      date,
      stored.get(date),
      incoming,
      submittedClients,
      rejectedClients,
      coverages
    );
    warnings.push(...dayWarnings);
    if (!daysEqual(stored.get(date), merged)) changedDays.set(date, merged);
  }

  // Stored days absent from this submission: authoritative coverage may
  // tombstone clients whose local logs no longer mention those dates.
  if (coverages.length > 0) {
    for (const [date, storedDay] of stored) {
      if (incomingDates.has(date)) continue;
      const { merged, warnings: dayWarnings } = mergeDay(
        date,
        storedDay,
        undefined,
        submittedClients,
        rejectedClients,
        coverages
      );
      warnings.push(...dayWarnings);
      if (!daysEqual(storedDay, merged)) changedDays.set(date, merged);
    }
  }

  return changedDays;
}

/**
 * Every write the submission causes, in the order one D1 batch runs them —
 * one transaction, so a submission either applies fully or not at all.
 * Set-based statements (see INSERT_USAGE_SQL) keep the batch a handful of
 * queries even for a full-history first upload.
 */
function planStatements(
  env: Env,
  { payload, deviceId, deviceName, submissionId, receivedAt: now }: Submission,
  { storedActivity, mode, generation }: DeviceRecord,
  changedDays: Map<string, DayState>
): D1PreparedStatement[] {
  const contributions = payload.contributions ?? [];
  // The guard first: if another write landed since `loadDevice`, nothing
  // below runs, and the caller merges again from what is there now.
  const statements: D1PreparedStatement[] = [guard(env.TOKENS_DB, generation), bump(env.TOKENS_DB)];

  // One JSON row per (client, model, provider) of every changed day,
  // column order matching INSERT_USAGE_SQL after the leading device_id.
  const changedDates: string[] = [];
  const usageRows: (string | number)[][] = [];
  for (const [date, day] of changedDays) {
    changedDates.push(date);
    for (const [client, data] of day) {
      for (const [key, m] of data.models) {
        const sep = key.indexOf("\u0000");
        usageRows.push([
          date,
          client,
          key.slice(0, sep),
          key.slice(sep + 1),
          m.input,
          m.output,
          m.cacheRead,
          m.cacheWrite,
          m.reasoning,
          m.messages,
          m.cost,
          data.revision,
        ]);
      }
    }
  }
  const insertedRows = usageRows.length;

  if (changedDates.length > 0) {
    statements.push(
      env.TOKENS_DB.prepare(DELETE_USAGE_SQL).bind(deviceId, JSON.stringify(changedDates))
    );
  }
  for (const rows of chunk(usageRows, USAGE_ROWS_PER_STATEMENT)) {
    statements.push(env.TOKENS_DB.prepare(INSERT_USAGE_SQL).bind(deviceId, JSON.stringify(rows)));
  }

  // Per-day active time from the submission envelope.
  const activityRows: [string, number][] = [];
  for (const day of contributions) {
    if (day.activeTimeMs == null) continue;
    const activeTimeMs = asNonNegativeInt(day.activeTimeMs);
    if (storedActivity.get(day.date) !== activeTimeMs) {
      activityRows.push([day.date, activeTimeMs]);
    }
  }
  if (activityRows.length > 0) {
    statements.push(
      env.TOKENS_DB.prepare(UPSERT_ACTIVITY_SQL).bind(deviceId, JSON.stringify(activityRows))
    );
  }

  // Device row with envelope metadata.
  const tm = payload.timeMetrics;
  const mcpServers = Array.isArray(payload.mcpServers)
    ? payload.mcpServers.filter((s): s is string => typeof s === "string" && s.length > 0)
    : null;
  statements.push(
    env.TOKENS_DB.prepare(
      `INSERT INTO devices
           (id, name, first_seen, last_seen, cli_version, total_active_time_ms,
            longest_continuous_ms, max_concurrent_sessions, session_count, mcp_servers)
         VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (id) DO UPDATE SET
           name = coalesce(excluded.name, name),
           last_seen = excluded.last_seen,
           cli_version = coalesce(excluded.cli_version, cli_version),
           total_active_time_ms = coalesce(excluded.total_active_time_ms, total_active_time_ms),
           longest_continuous_ms = coalesce(excluded.longest_continuous_ms, longest_continuous_ms),
           max_concurrent_sessions = coalesce(excluded.max_concurrent_sessions, max_concurrent_sessions),
           session_count = coalesce(excluded.session_count, session_count),
           mcp_servers = coalesce(excluded.mcp_servers, mcp_servers)`
    ).bind(
      deviceId,
      deviceName,
      now,
      payload.meta?.version ?? null,
      tm ? asNonNegativeInt(tm.totalActiveTimeMs) : null,
      tm ? asNonNegativeInt(tm.longestContinuousMs) : null,
      tm ? asNonNegativeInt(tm.maxConcurrentSessions) : null,
      tm ? asNonNegativeInt(tm.sessionCount) : null,
      mcpServers && mcpServers.length > 0 ? JSON.stringify(mcpServers) : null
    )
  );

  // Audit row.
  const dates = contributions.map((d) => d.date).sort();
  statements.push(
    env.TOKENS_DB.prepare(
      `INSERT INTO submissions
           (id, device_id, received_at, date_start, date_end, total_tokens,
            total_cost, row_count, changed_days, cli_version, generated_at,
            mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      submissionId,
      deviceId,
      now,
      dates[0],
      dates[dates.length - 1],
      asNonNegativeInt(payload.summary?.totalTokens),
      asNonNegativeNumber(payload.summary?.totalCost),
      insertedRows,
      changedDays.size,
      payload.meta?.version ?? null,
      payload.meta?.generatedAt ?? null,
      mode
    )
  );
  // Retention, in the same transaction as the row it balances. The audit
  // log answers "did the last report land, and how often do they come" —
  // a question only about recent history, while the table itself grows
  // ~80 rows a day forever (over 80% of them no-ops: devices rescan every
  // 30 minutes whether or not anything changed). Unbounded it also
  // dominated the daily R2 export, which copies whatever it finds *every
  // day* — quadratic storage growth for a log nobody reads past a week.
  statements.push(
    env.TOKENS_DB.prepare(`DELETE FROM submissions WHERE received_at < ?`).bind(
      now - AUDIT_RETENTION_DAYS * 86_400_000
    )
  );

  return statements;
}

/** Account-wide totals for the response body (the official server
 *  recalculates these too); one aggregate query, clients folded in as a
 *  JSON array so the distinct list does not cost a second statement. */
async function accountMetrics(db: D1Database) {
  const metrics = await db
    .prepare(
      `SELECT
         coalesce(sum(${TOKENS_SQL}), 0) AS totalTokens,
         coalesce(sum(u.cost), 0) AS totalCost,
         min(u.date) AS dateStart,
         max(u.date) AS dateEnd,
         ${ACTIVE_DAYS_SQL},
         json_group_array(DISTINCT u.client) AS clients
       FROM daily_usage u`
    )
    .first<{
      totalTokens: number;
      totalCost: number;
      dateStart: string | null;
      dateEnd: string | null;
      activeDays: number;
      clients: string;
    }>();
  return {
    totalTokens: metrics?.totalTokens ?? 0,
    totalCost: metrics?.totalCost ?? 0,
    dateRange: { start: metrics?.dateStart ?? null, end: metrics?.dateEnd ?? null },
    activeDays: metrics?.activeDays ?? 0,
    clients: (JSON.parse(metrics?.clients ?? "[]") as string[]).sort(),
  };
}

/** Merges per submission before giving up on a busy store (503). */
const SUBMIT_ATTEMPTS = 3;

/**
 * Put the raw payload, then take it back if a wipe committed after this
 * submission did: the put can land after the wipe listed the bucket, and
 * the wipe is a promise that nothing submitted before it survives.
 */
async function archiveRaw(
  env: Env,
  { deviceId, submissionId, receivedAt }: Submission,
  rawBody: string,
  committed: number
): Promise<void> {
  const key = `raw/${deviceId}/latest.json`;
  await env.TOKENS_ARCHIVE.put(key, rawBody, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { submissionId, receivedAt: String(receivedAt) },
  });
  if ((await readState(env.TOKENS_DB)).wiped > committed) {
    await env.TOKENS_ARCHIVE.delete(key);
  }
}

export async function handleSubmit(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!(await isAuthorized(request, env.TOKENS_API_TOKEN))) {
    return json({ error: "Invalid API token" }, 401);
  }

  const rawBody = await request.text();
  let payload: SubmissionPayload;
  try {
    payload = JSON.parse(rawBody) as SubmissionPayload;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  normalizePayload(payload);
  const { errors, warnings } = validatePayload(payload);
  if (errors.length > 0) {
    return json({ error: "Validation failed", details: errors.slice(0, 50) }, 400);
  }
  const contributions = payload.contributions ?? [];
  if (contributions.length === 0) {
    return json({ error: "No contribution data to submit" }, 400);
  }

  const deviceId = payload.device?.id?.trim() || LEGACY_DEVICE_KEY;
  const submission: Submission = {
    payload,
    deviceId,
    deviceName:
      payload.device?.name?.trim() || (deviceId === LEGACY_DEVICE_KEY ? LEGACY_DEVICE_NAME : null),
    submissionId: crypto.randomUUID(),
    receivedAt: Date.now(),
  };

  // Read, merge, write — with the write fenced by the counter (state.ts).
  // Two overlapping submissions from one device (`tokens serve` and a
  // manual submit) would otherwise both merge against the same stored
  // rows, and the later write would undo the regression guard's verdict
  // on the earlier one. A batch whose guard fails rolls back whole; the
  // merge is then redone against the rows that beat it.
  let accepted: { device: DeviceRecord; warnings: string[] } | undefined;
  for (let attempt = 0; attempt < SUBMIT_ATTEMPTS && !accepted; attempt++) {
    const attemptWarnings = [...warnings];
    const device = await loadDevice(env, deviceId);
    const changedDays = mergeSubmission(payload, device.stored, attemptWarnings);
    try {
      await env.TOKENS_DB.batch(planStatements(env, submission, device, changedDays));
      accepted = { device, warnings: attemptWarnings };
    } catch (error) {
      // Only a moved counter is a lost race; anything else is a failure.
      if ((await readState(env.TOKENS_DB)).generation === device.generation) throw error;
    }
  }
  if (!accepted) {
    return json({ error: "Other writes kept landing during this submission; retry it" }, 503);
  }
  const { device } = accepted;
  const committed = device.generation + 1;

  // Archive the accepted payload verbatim. Submissions are full rescans,
  // so the latest one per device reproduces its whole history — enough to
  // replay-rebuild after a schema change (daily R2 exports cover the rest).
  ctx.waitUntil(archiveRaw(env, submission, rawBody, committed));

  // Submissions are the only event that changes the data, so they drive
  // the KV site payload and the daily R2 export directly — devices report
  // every 30 minutes, so neither needs a scheduled job.
  ctx.waitUntil(refresh(env, tokensSite));
  ctx.waitUntil(ensureDailyBackup(env));

  return json({
    success: true,
    submissionId: submission.submissionId,
    username: env.TOKENS_USERNAME,
    metrics: await accountMetrics(env.TOKENS_DB),
    mode: device.mode,
    warnings: accepted.warnings.length > 0 ? accepted.warnings.slice(0, 50) : undefined,
  });
}

/** GET /tokens/api/auth/token — token validation used by `tokens login --token`. */
export async function handleAuthToken(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env.TOKENS_API_TOKEN))) {
    return json({ error: "Invalid API token" }, 401);
  }
  return json({ user: { username: env.TOKENS_USERNAME, avatarUrl: null } });
}

/**
 * DELETE /tokens/api/settings/submitted-data — wipe everything for this account,
 * across all three stores: the five D1 tables (the reported quota plans
 * name the account's subscriptions, so they go too), every R2 object
 * (raw payload archives and daily exports reproduce submitted data), and
 * the precomposed KV site payload, which is recomposed synchronously so the public dashboard
 * never serves deleted data after the CLI has been told the deletion
 * succeeded. Runs unconditionally, so a retry completes whatever a
 * failed earlier attempt left behind.
 */
export async function handleDeleteSubmittedData(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env.TOKENS_API_TOKEN))) {
    return json({ error: "Invalid API token" }, 401);
  }
  const count = await env.TOKENS_DB.prepare(`SELECT count(*) AS n FROM submissions`).first<{
    n: number;
  }>();
  const n = count?.n ?? 0;
  await env.TOKENS_DB.batch([
    env.TOKENS_DB.prepare(`DELETE FROM daily_usage`),
    env.TOKENS_DB.prepare(`DELETE FROM daily_activity`),
    env.TOKENS_DB.prepare(`DELETE FROM devices`),
    env.TOKENS_DB.prepare(`DELETE FROM submissions`),
    env.TOKENS_DB.prepare(`DELETE FROM quota_plans`),
    // Fails every submission still between its read and its write, and
    // fences every composition still in flight (state.ts).
    bumpForWipe(env.TOKENS_DB),
  ]);
  await wipeArchive(env);
  await refresh(env, tokensSite);
  return json({ deleted: n > 0, deletedSubmissions: n });
}
