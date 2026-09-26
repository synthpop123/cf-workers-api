/**
 * One sync leg: read everything znma will answer for, write it to D1 as a
 * single atomic batch, mirror any new artwork, then recompose the public
 * payload.
 *
 * Nintendo returns daily summaries as a rolling window it eventually drops,
 * so a sync is an upsert over the days it still offers — never a replace.
 * History past that window survives only because it is already in D1.
 */

import type { Env } from "../../env";
import { coverSource, mirrorCover } from "./images";
import { fetchIdToken } from "./moon/auth";
import { MoonClient } from "./moon/client";
import { MOON_CLIENT_CONFIG } from "./moon/config";
import type { DailySummary, OwnedDevice, ParentalControlSetting, PlayedGame } from "./moon/types";
import { applicationId } from "./moon/types";
import { refreshSiteCache } from "./site";
import { refreshExchangeRate, resolveStoreFacts } from "./store";

interface DeviceRow {
  id: string;
  label: string;
  external_nickname: string | null;
  region: string | null;
  platform_generation: string | null;
  serial_number: string | null;
  setting_status: string | null;
  extra_playing_time: number | null;
  icon_light_url: string | null;
  icon_dark_url: string | null;
  paired_at: number | null;
  first_seen: number;
  last_seen: number;
  raw: string;
}

interface PlayerRow {
  player_id: string;
  device_id: string;
  nsa_id: string | null;
  nickname: string;
  image_url: string | null;
  first_seen: number;
  last_seen: number;
}

interface SummaryRow {
  device_id: string;
  date: string;
  result: string;
  playing_time: number;
  misc_time: number;
  exceeded_time: number;
  disabled_time: number;
  tz_offset_seconds: number | null;
  featured_image_url: string | null;
  observed_at: number | null;
  updated_at: number;
  raw: string;
}

interface DailyPlayerRow {
  device_id: string;
  date: string;
  player_id: string;
  playing_time: number;
  updated_at: number;
}

interface DailyGameRow {
  device_id: string;
  date: string;
  player_id: string;
  application_id: string;
  playing_time: number;
  updated_at: number;
}

interface GameRow {
  application_id: string;
  title: string;
  shop_url: string | null;
  has_ugc: number | null;
  safe_launch: string | null;
  first_play_date: string | null;
  image_extra_small: string | null;
  image_small: string | null;
  image_medium: string | null;
  image_large: string | null;
  image_extra_large: string | null;
  image_key: string | null;
  first_seen: number;
  updated_at: number;
}

/** An unlock code is a PIN. It has no analytical value, so it is never kept. */
function redact<T>(value: T): string {
  return JSON.stringify(value, (key, v) =>
    key === "unlockCode" || key === "synchronizedUnlockCode" ? undefined : v
  );
}

function gameRow(game: PlayedGame, appId: string, now: number): GameRow {
  const meta = game.meta;
  return {
    application_id: appId,
    title: meta?.title ?? appId,
    shop_url: meta?.shopUri ?? null,
    has_ugc: meta?.hasUgc === undefined ? null : meta.hasUgc ? 1 : 0,
    safe_launch: null,
    first_play_date: null,
    image_extra_small: meta?.imageUri?.extraSmall ?? null,
    image_small: meta?.imageUri?.small ?? null,
    image_medium: meta?.imageUri?.medium ?? null,
    image_large: meta?.imageUri?.large ?? null,
    image_extra_large: meta?.imageUri?.extraLarge ?? null,
    image_key: null,
    first_seen: now,
    updated_at: now,
  };
}

interface DayHarvest {
  summary: SummaryRow;
  players: DailyPlayerRow[];
  games: DailyGameRow[];
}

/**
 * The catalog under construction. `seenOn` is the day each row's title and
 * art came from, so the newest day wins whatever order devices and days
 * arrive in — a renamed or re-keyed cover should overtake the one an older
 * day carried, and never the other way round.
 */
interface Catalog {
  rows: Map<string, GameRow>;
  seenOn: Map<string, string>;
}

/**
 * A day's rows. Nintendo reports per player, and a player can appear twice
 * for the same title, so game minutes are summed per (player, application).
 */
function harvestDay(
  deviceId: string,
  summary: DailySummary,
  observedAt: number | null,
  now: number,
  players: Map<string, PlayerRow>,
  catalog: Catalog
): DayHarvest {
  const playerRows: DailyPlayerRow[] = [];
  const gameRows = new Map<string, DailyGameRow>();

  for (const player of summary.players ?? []) {
    const profile = player.profile;
    if (!profile) continue;

    const existing = players.get(profile.playerId);
    players.set(profile.playerId, {
      player_id: profile.playerId,
      device_id: deviceId,
      nsa_id: profile.nsaId ?? null,
      nickname: profile.nickname,
      image_url: profile.imageUri ?? null,
      first_seen: existing?.first_seen ?? now,
      last_seen: now,
    });

    playerRows.push({
      device_id: deviceId,
      date: summary.date,
      player_id: profile.playerId,
      playing_time: player.playingTime ?? 0,
      updated_at: now,
    });

    for (const game of player.playedGames ?? []) {
      const appId = applicationId(game);
      if (!appId) continue;

      const key = `${profile.playerId}:${appId}`;
      const row = gameRows.get(key);
      if (row) row.playing_time += game.playingTime;
      else
        gameRows.set(key, {
          device_id: deviceId,
          date: summary.date,
          player_id: profile.playerId,
          application_id: appId,
          playing_time: game.playingTime,
          updated_at: now,
        });

      const seen = catalog.seenOn.get(appId);
      if (seen === undefined || summary.date >= seen) {
        catalog.seenOn.set(appId, summary.date);
        catalog.rows.set(appId, gameRow(game, appId, now));
      }
    }
  }

  return {
    summary: {
      device_id: deviceId,
      date: summary.date,
      result: summary.result,
      playing_time: summary.playingTime,
      misc_time: summary.miscTime ?? 0,
      exceeded_time: summary.exceededTime ?? 0,
      disabled_time: summary.disabledTime ?? 0,
      tz_offset_seconds: summary.timeZoneUtcOffsetSeconds ?? null,
      featured_image_url: coverSource(summary.featuredGameIconURL),
      observed_at: observedAt,
      updated_at: now,
      raw: redact(summary),
    },
    players: playerRows,
    games: [...gameRows.values()],
  };
}

/**
 * Fold the setting document's whitelist into the catalog rows it enriches.
 * Runs once every device's days are in, so a later device's newer day
 * cannot overwrite what an earlier device's whitelist just supplied.
 */
function applyWhitelist(
  setting: ParentalControlSetting,
  games: Map<string, GameRow>,
  now: number
): void {
  for (const app of setting.whitelistedApplicationList ?? []) {
    const row = games.get(app.applicationId) ?? {
      ...gameRow({ playingTime: 0 }, app.applicationId, now),
      title: app.title ?? app.applicationId,
      image_small: app.imageUri ?? null,
    };
    games.set(app.applicationId, {
      ...row,
      title: row.title === app.applicationId ? (app.title ?? row.title) : row.title,
      first_play_date: app.firstPlayDate ?? row.first_play_date,
      safe_launch: app.safeLaunch ?? row.safe_launch,
    });
  }
}

/**
 * `INSERT … SELECT json_each(?)`: changed rows travel as one JSON parameter
 * and are expanded server-side, so a full-history sync stays a handful of
 * statements in one D1 batch.
 */
type TableSpec<Row> = { [Column in keyof Row]: "key" | "set" | "keep" | "once" };

function upsert<Row extends object>(
  db: D1Database,
  table: string,
  spec: TableSpec<Row>,
  rows: Row[]
): D1PreparedStatement | null {
  if (rows.length === 0) return null;
  // Specs are static, exhaustive over Row, and never contain request input.
  const columns = Object.keys(spec) as (keyof Row & string)[];
  const conflict = columns.filter((c) => spec[c] === "key");
  const update = columns.flatMap((c) => {
    if (spec[c] === "set") return [`${c} = excluded.${c}`];
    if (spec[c] === "keep") return [`${c} = COALESCE(excluded.${c}, ${table}.${c})`];
    return [];
  });
  const select = columns.map((c) => `json_extract(value, '$.${c}')`).join(", ");
  return db
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")})
     SELECT ${select} FROM json_each(?) WHERE true
     ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${update.join(", ")}`
    )
    .bind(JSON.stringify(rows));
}

const DEVICES: TableSpec<DeviceRow> = {
  id: "key",
  label: "set",
  external_nickname: "set",
  region: "set",
  platform_generation: "set",
  serial_number: "set",
  setting_status: "set",
  extra_playing_time: "set",
  icon_light_url: "set",
  icon_dark_url: "set",
  paired_at: "set",
  first_seen: "once",
  last_seen: "set",
  raw: "set",
};

const PLAYERS: TableSpec<PlayerRow> = {
  player_id: "key",
  device_id: "set",
  nsa_id: "set",
  nickname: "set",
  image_url: "set",
  first_seen: "once",
  last_seen: "set",
};

const DAILY_SUMMARIES: TableSpec<SummaryRow> = {
  device_id: "key",
  date: "key",
  result: "set",
  playing_time: "set",
  misc_time: "set",
  exceeded_time: "set",
  disabled_time: "set",
  tz_offset_seconds: "set",
  featured_image_url: "keep",
  observed_at: "set",
  updated_at: "set",
  raw: "set",
};

const DAILY_PLAYERS: TableSpec<DailyPlayerRow> = {
  device_id: "key",
  date: "key",
  player_id: "key",
  playing_time: "set",
  updated_at: "set",
};

const DAILY_GAMES: TableSpec<DailyGameRow> = {
  device_id: "key",
  date: "key",
  player_id: "key",
  application_id: "key",
  playing_time: "set",
  updated_at: "set",
};

const GAMES: TableSpec<GameRow> = {
  application_id: "key",
  title: "set",
  shop_url: "keep",
  has_ugc: "keep",
  safe_launch: "keep",
  first_play_date: "keep",
  image_extra_small: "keep",
  image_small: "keep",
  image_medium: "keep",
  image_large: "keep",
  image_extra_large: "keep",
  image_key: "keep",
  first_seen: "once",
  updated_at: "set",
};

const SETTING_SNAPSHOTS: TableSpec<SettingRow> = {
  device_id: "key",
  etag: "key",
  restriction_level: "set",
  captured_at: "once",
  raw: "set",
};

/**
 * Recompute the catalog's aggregate tail. Per-day rows are authoritative, so
 * the totals are always derived rather than incremented.
 */
function rollUpGames(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `UPDATE games SET
       total_playing_time = COALESCE(agg.total, 0),
       day_count = COALESCE(agg.days, 0),
       first_played_date = agg.first_date,
       last_played_date = agg.last_date
     FROM (
       SELECT application_id,
              SUM(playing_time) AS total,
              COUNT(DISTINCT date) AS days,
              MIN(date) AS first_date,
              MAX(date) AS last_date
       FROM daily_games
       GROUP BY application_id
     ) AS agg
     WHERE agg.application_id = games.application_id`
  );
}

export interface SyncResult {
  ok: true;
  syncId: string;
  deviceCount: number;
  dayCount: number;
  gameCount: number;
  imageCount: number;
  priceCount: number;
}

export async function runSync(env: Env): Promise<SyncResult> {
  const syncId = crypto.randomUUID();
  const startedAt = Date.now();

  await env.SWITCH_DB.prepare(
    `INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'running')`
  )
    .bind(syncId, startedAt)
    .run();

  try {
    const moon = new MoonClient(await fetchIdToken(env.PCTL_SESSION_TOKEN), MOON_CLIENT_CONFIG);
    const [{ user }, { ownedDevices }] = await Promise.all([moon.getUser(), moon.getDevices()]);

    const now = Date.now();
    const deviceRows: DeviceRow[] = [];
    const summaryRows: SummaryRow[] = [];
    const dailyPlayerRows: DailyPlayerRow[] = [];
    const dailyGameRows: DailyGameRow[] = [];
    const players = new Map<string, PlayerRow>();
    const catalog: Catalog = { rows: new Map(), seenOn: new Map() };
    const games = catalog.rows;
    const settings: ParentalControlSetting[] = [];
    const settingRows: SettingRow[] = [];
    let imageCount = 0;

    for (const device of ownedDevices) {
      const [daily, setting] = await Promise.all([
        moon.getDailySummaries(device.deviceId),
        moon.getParentalControlSetting(device.deviceId).catch(() => null),
      ]);

      const observedAt = daily.lastUpdatedAt ? daily.lastUpdatedAt * 1000 : null;
      for (const summary of daily.dailySummaries) {
        const day = harvestDay(device.deviceId, summary, observedAt, now, players, catalog);
        summaryRows.push(day.summary);
        dailyPlayerRows.push(...day.players);
        dailyGameRows.push(...day.games);
      }

      if (setting) {
        const pcs = setting.parentalControlSetting;
        settings.push(pcs);
        settingRows.push({
          device_id: device.deviceId,
          etag: pcs.etag ?? String(pcs.updatedAt ?? now),
          restriction_level: pcs.functionalRestrictionLevel ?? null,
          captured_at: now,
          raw: redact(pcs),
        });
      }

      deviceRows.push(deviceRowFor(device, now));
    }

    for (const setting of settings) applyWhitelist(setting, games, now);

    const { results: storedCovers } = await env.SWITCH_DB.prepare(
      "SELECT application_id, image_key FROM games WHERE image_key IS NOT NULL"
    ).all<{ application_id: string; image_key: string }>();
    const knownCovers = new Map(storedCovers.map((row) => [row.application_id, row.image_key]));
    for (const game of games.values()) {
      const mirrored = await mirrorCover(
        env,
        coverSource({
          extraSmall: game.image_extra_small ?? undefined,
          small: game.image_small ?? undefined,
          medium: game.image_medium ?? undefined,
          large: game.image_large ?? undefined,
          extraLarge: game.image_extra_large ?? undefined,
        }),
        knownCovers.get(game.application_id)
      );
      game.image_key = mirrored.key;
      if (mirrored.copied) imageCount += 1;
    }

    await writeAll(env.SWITCH_DB, {
      user,
      deviceRows,
      players: [...players.values()],
      summaryRows,
      dailyPlayerRows,
      dailyGameRows,
      games: [...games.values()],
      settingRows,
      now,
    });

    // After the roll-up, so a title's first playtime is what makes it
    // eligible for a price — and before the payload is recomposed.
    const [priceCount] = await Promise.all([
      resolveStoreFacts(env, now),
      refreshExchangeRate(env, now),
    ]);
    await refreshSiteCache(env);

    const result: SyncResult = {
      ok: true,
      syncId,
      deviceCount: ownedDevices.length,
      dayCount: summaryRows.length,
      gameCount: games.size,
      imageCount,
      priceCount,
    };

    await env.SWITCH_DB.prepare(
      `UPDATE sync_runs
       SET finished_at = ?, status = 'ok',
           device_count = ?, day_count = ?, game_count = ?, image_count = ?,
           price_count = ?
       WHERE id = ?`
    )
      .bind(
        Date.now(),
        result.deviceCount,
        result.dayCount,
        result.gameCount,
        result.imageCount,
        result.priceCount,
        syncId
      )
      .run();

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.SWITCH_DB.prepare(
      `UPDATE sync_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?`
    )
      .bind(Date.now(), message, syncId)
      .run();
    throw error;
  }
}

function deviceRowFor(device: OwnedDevice, now: number): DeviceRow {
  const info = device.device;
  const lightUrl = info.iconUri?.lightTheme?.middle ?? info.iconUri?.lightTheme?.small ?? null;
  const darkUrl = info.iconUri?.darkTheme?.middle ?? info.iconUri?.darkTheme?.small ?? null;

  return {
    id: device.deviceId,
    label: device.label,
    external_nickname: info.externalNickname ?? null,
    region: info.region ?? null,
    platform_generation: info.platformGeneration ?? null,
    serial_number: info.serialNumber ?? null,
    setting_status: device.parentalControlSettingStatus ?? null,
    extra_playing_time: info.extraPlayingTime ?? null,
    icon_light_url: lightUrl,
    icon_dark_url: darkUrl,
    paired_at: device.createdAt ? device.createdAt * 1000 : null,
    first_seen: now,
    last_seen: now,
    raw: redact(device),
  };
}

interface SettingRow {
  device_id: string;
  etag: string;
  restriction_level: string | null;
  captured_at: number;
  raw: string;
}

interface WriteSet {
  user: {
    nintendoAccountId: string;
    nickname: string;
    country?: string;
    language?: string;
    miiUri?: { medium?: string };
  };
  deviceRows: DeviceRow[];
  players: PlayerRow[];
  summaryRows: SummaryRow[];
  dailyPlayerRows: DailyPlayerRow[];
  dailyGameRows: DailyGameRow[];
  games: GameRow[];
  settingRows: SettingRow[];
  now: number;
}

function writeAll(db: D1Database, set: WriteSet): Promise<unknown> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO account (nintendo_account_id, nickname, country, language, mii_url, updated_at, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (nintendo_account_id) DO UPDATE SET
           nickname = excluded.nickname,
           country = excluded.country,
           language = excluded.language,
           mii_url = excluded.mii_url,
           updated_at = excluded.updated_at,
           raw = excluded.raw`
      )
      .bind(
        set.user.nintendoAccountId,
        set.user.nickname,
        set.user.country ?? null,
        set.user.language ?? null,
        set.user.miiUri?.medium ?? null,
        set.now,
        redact(set.user)
      ),
  ];

  const push = (statement: D1PreparedStatement | null) => {
    if (statement) statements.push(statement);
  };

  push(upsert(db, "devices", DEVICES, set.deviceRows));

  push(upsert(db, "players", PLAYERS, set.players));

  push(upsert(db, "daily_summaries", DAILY_SUMMARIES, set.summaryRows));

  push(upsert(db, "daily_players", DAILY_PLAYERS, set.dailyPlayerRows));

  push(upsert(db, "daily_games", DAILY_GAMES, set.dailyGameRows));

  push(upsert(db, "games", GAMES, set.games));

  push(upsert(db, "setting_snapshots", SETTING_SNAPSHOTS, set.settingRows));

  statements.push(rollUpGames(db));
  return db.batch(statements);
}
