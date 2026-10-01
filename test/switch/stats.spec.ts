import { describe, expect, it } from "vitest";
import {
  buildLibrary,
  computeStats,
  denseActivity,
  type GameRow,
} from "../../src/services/switch/stats";

const rows: GameRow[] = [
  {
    application_id: "A",
    title: "Alpha",
    image_url: "https://img.example/a.jpg",
    shop_url: null,
    total_playing_time: 40,
    last_played_date: "2026-08-28",
    price_hkd_cents: 32900,
  },
  {
    application_id: "B",
    title: "Beta",
    image_url: null,
    shop_url: "https://shop.example/b",
    total_playing_time: 65,
    last_played_date: "2026-08-29",
    price_hkd_cents: null,
  },
  {
    application_id: "C",
    title: "Never played",
    image_url: null,
    shop_url: null,
    total_playing_time: 0,
    last_played_date: null,
    price_hkd_cents: 50000,
  },
];

describe("denseActivity", () => {
  it("zero-fills the gaps between reported days", () => {
    expect(
      denseActivity(
        [
          { date: "2026-08-25", playing_time: 60 },
          { date: "2026-08-28", playing_time: 15 },
        ],
        "2026-08-29",
        365
      )
    ).toEqual([
      { date: "2026-08-25", minutes: 60 },
      { date: "2026-08-26", minutes: 0 },
      { date: "2026-08-27", minutes: 0 },
      { date: "2026-08-28", minutes: 15 },
      { date: "2026-08-29", minutes: 0 },
    ]);
  });

  it("drops days outside the window and returns nothing when empty", () => {
    expect(denseActivity([{ date: "2020-01-01", playing_time: 60 }], "2026-08-29", 365)).toEqual(
      []
    );
    expect(denseActivity([], "2026-08-29", 365)).toEqual([]);
  });

  it("passes znma minutes through without scaling", () => {
    const [day] = denseActivity([{ date: "2026-08-29", playing_time: 65 }], "2026-08-29", 365);
    expect(day.minutes).toBe(65);
  });
});

describe("computeStats", () => {
  it("computes totals, averages and streaks", () => {
    const stats = computeStats(
      [
        { date: "2026-08-26", minutes: 60 },
        { date: "2026-08-27", minutes: 30 },
        { date: "2026-08-28", minutes: 0 },
        { date: "2026-08-29", minutes: 30 },
      ],
      buildLibrary(rows, new Map(), 0.86)
    );
    expect(stats).toMatchObject({
      totalMinutes: 120,
      daysActive: 3,
      daysTracked: 4,
      avgDailyMinutes: 40,
      longestStreak: 2,
      currentStreak: 1,
      firstDate: "2026-08-26",
      lastPlayedDate: "2026-08-29",
      gameCount: 2,
      // Only Alpha carries a price, and only the played rows count.
      libraryValueCny: 283,
      pricedGameCount: 1,
    });
  });

  it("keeps the streak alive on a day that has not started yet", () => {
    const stats = computeStats(
      [
        { date: "2026-08-27", minutes: 30 },
        { date: "2026-08-28", minutes: 30 },
        { date: "2026-08-29", minutes: 0 },
      ],
      buildLibrary(rows, new Map(), 0.86)
    );
    expect(stats.currentStreak).toBe(2);
  });

  it("reports nothing for an empty series", () => {
    expect(computeStats([], buildLibrary([], new Map(), 0.86))).toMatchObject({
      totalMinutes: 0,
      daysActive: 0,
      currentStreak: 0,
      longestStreak: 0,
      firstDate: null,
      lastPlayedDate: null,
      gameCount: 0,
      libraryValueCny: null,
      pricedGameCount: 0,
    });
  });
});

describe("buildLibrary", () => {
  it("ranks by lifetime minutes and attaches the recent window", () => {
    const { games } = buildLibrary(rows, new Map([["A", 40]]), 0.86);
    expect(games.map((g) => g.applicationId)).toEqual(["B", "A"]);
    expect(games[0].recentMinutes).toBe(0);
    expect(games[1].recentMinutes).toBe(40);
  });

  it("drops owned-but-unplayed titles from the ranking and the value", () => {
    const library = buildLibrary(rows, new Map(), 0.86);
    expect(library.games.some((g) => g.applicationId === "C")).toBe(false);
    expect(library.pricedCount).toBe(1);
    expect(library.valueCny).toBe(283);
  });

  it("reports no value without a rate or without a price", () => {
    expect(buildLibrary(rows, new Map(), null).valueCny).toBeNull();
    expect(buildLibrary([], new Map(), 0.86)).toMatchObject({
      valueCny: null,
      pricedCount: 0,
    });
  });
});
