import { describe, expect, it } from "vitest";
import { HISTORY_START, readHistory } from "../../src/services/portfolio/wealthfolio";

/** `count` consecutive days from 2025-01-01. */
function valuations(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    return { date, totalValue: 1000 + i, netContribution: 1000, currency: "USD" };
  });
}

/** Wealthfolio 3.12's get_valuation_history: the range's earliest 400
 *  points, flagged when there were more. */
function wealthfolio(all: ReturnType<typeof valuations>) {
  const asked: string[] = [];
  const call = async ({ startDate }: Record<string, unknown>) => {
    asked.push(String(startDate));
    const range = all.filter((point) => point.date >= String(startDate));
    const valuations = range.slice(0, 400);
    return valuations.length < range.length
      ? { valuations, truncated: true, originalCount: range.length }
      : { valuations };
  };
  return { call, asked };
}

describe("readHistory", () => {
  it("reads a short history in one call", async () => {
    const { call, asked } = wealthfolio(valuations(348));
    expect(await readHistory(call)).toHaveLength(348);
    expect(asked).toEqual([HISTORY_START]);
  });

  it("pages past the 400-point cap instead of stopping at day 400", async () => {
    const { call, asked } = wealthfolio(valuations(401));
    const days = await readHistory(call);
    expect(days).toHaveLength(401);
    expect(days.at(-1)).toEqual({ date: "2026-02-05", value: 1400, invested: 1000 });
    expect(asked).toEqual([HISTORY_START, "2026-02-05"]);
  });

  it("reads years of history, every day once and in order", async () => {
    const { call, asked } = wealthfolio(valuations(1200));
    const days = await readHistory(call);
    expect(days.map((day) => day.value)).toEqual(valuations(1200).map((v) => v.totalValue));
    expect(asked).toHaveLength(3);
  });

  it("fails rather than ship a history with a hole in it", async () => {
    // A server that flags the cut but then answers nothing more.
    const first = { valuations: valuations(400), truncated: true, originalCount: 401 };
    let calls = 0;
    await expect(
      readHistory(async () => (calls++ === 0 ? first : { valuations: [] }))
    ).rejects.toThrow("short: 400 of 401");
  });

  it("fails on pages that overlap", async () => {
    const page = { valuations: valuations(400), truncated: true, originalCount: 800 };
    await expect(readHistory(async () => page)).rejects.toThrow("out of order");
  });
});
