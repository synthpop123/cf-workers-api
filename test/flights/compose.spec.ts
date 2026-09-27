import { describe, expect, it } from "vitest";
import { composeSite, greatCircleKm, SITE_VERSION } from "../../src/services/flights/compose";
import { GMP, PEK, SHA, upstream } from "./fixtures";

describe("greatCircleKm", () => {
  it("measures Hongqiao to Capital at about 1,080 km", () => {
    expect(greatCircleKm(SHA, PEK)).toBeGreaterThan(1050);
    expect(greatCircleKm(SHA, PEK)).toBeLessThan(1100);
  });
});

describe("composeSite", () => {
  const today = "2026-01-01";

  it("ships the map and the last flight, never who, which seat or when in the day", () => {
    const site = composeSite([upstream()], today);
    const text = JSON.stringify(site);
    for (const secret of [
      "JYV0WB",
      "PNR",
      "57L",
      "B-2037",
      "u1",
      "seat",
      "passengers",
      "CCA1502",
      "CA1502",
      "04:27",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(site.schemaVersion).toBe(SITE_VERSION);
    expect(Object.keys(site).sort()).toEqual(
      [
        "aircraft",
        "airlines",
        "airports",
        "last",
        "routes",
        "schemaVersion",
        "stats",
        "today",
      ].sort()
    );
    expect(site.routes).toEqual([
      {
        from: "PEK",
        to: "SHA",
        flights: 1,
        upcoming: 0,
        km: greatCircleKm(SHA, PEK),
        minutes: 118,
      },
    ]);
    expect(site.airlines).toEqual([{ code: "CA", name: "Air China", flights: 1 }]);
    expect(site.aircraft).toEqual([{ code: "B77W", name: "Boeing 777-300ER", flights: 1 }]);
  });

  it("ships the last flight flown, as flown, and breaks a same-day tie by departure", () => {
    const site = composeSite(
      [
        upstream(),
        upstream({
          date: "2025-11-02",
          departure: "2025-11-02T01:00:00.000+00:00",
          from: PEK,
          to: GMP,
        }),
        upstream({
          date: "2025-11-02",
          departure: "2025-11-02T09:00:00.000+00:00",
          from: GMP,
          to: SHA,
          duration: null,
          airline: null,
          aircraft: null,
        }),
        upstream({ date: "2026-03-01", from: SHA, to: PEK }),
      ],
      today
    );
    expect(site.last).toEqual({
      date: "2025-11-02",
      from: "GMP",
      to: "SHA",
      km: greatCircleKm(GMP, SHA),
      minutes: null,
      airline: null,
      aircraft: null,
    });
    expect(composeSite([upstream({ date: "2026-03-01" })], today).last).toBeNull();
  });

  it("names the city without AirTrail's district", () => {
    const site = composeSite([upstream()], today);
    expect(site.airports.find((a) => a.code === "SHA")?.city).toBe("Shanghai");
  });

  it("merges a route flown both ways and averages its known durations", () => {
    const site = composeSite(
      [
        upstream({ duration: 7200 }),
        upstream({ from: PEK, to: SHA, duration: 6000 }),
        upstream({ from: PEK, to: SHA, duration: null }),
        upstream({ from: PEK, to: GMP }),
      ],
      today
    );
    expect(site.stats).toMatchObject({ routes: 2, flights: 4 });
    expect(site.routes[0]).toMatchObject({ from: "PEK", to: "SHA", flights: 3, minutes: 110 });
    expect(site.routes[1]).toMatchObject({ from: "GMP", to: "PEK", flights: 1 });
    expect(site.airports[0]).toMatchObject({ code: "PEK", visits: 4 });
  });

  it("orders routes by flights, then by length", () => {
    const site = composeSite(
      [upstream(), upstream({ from: PEK, to: GMP }), upstream({ from: SHA, to: GMP })],
      today
    );
    const pair = (from: typeof PEK, to: typeof PEK) => greatCircleKm(from, to);
    expect(site.routes.map((r) => r.km)).toEqual(
      [pair(PEK, SHA), pair(PEK, GMP), pair(SHA, GMP)].sort((a, b) => b - a)
    );
  });

  it("keeps upcoming flights out of the stats and the visit counts", () => {
    const site = composeSite(
      [upstream(), upstream({ date: "2026-03-01", from: PEK, to: GMP })],
      today
    );
    expect(site.stats).toMatchObject({
      flights: 1,
      upcoming: 1,
      airports: 2,
      countries: 1,
      routes: 1,
      firstDate: "2025-10-09",
      lastDate: "2025-10-09",
    });
    expect(site.routes.find((r) => r.to === "PEK" && r.from === "GMP")).toMatchObject({
      flights: 0,
      upcoming: 1,
    });
    expect(site.airports.find((a) => a.code === "GMP")?.visits).toBe(0);
    expect(site.airports.find((a) => a.code === "PEK")?.visits).toBe(1);
  });

  it("tallies airlines and aircraft over flown flights, most first", () => {
    const eastern = { name: "China Eastern", icao: "CES", iata: "MU" };
    const site = composeSite(
      [
        upstream({ airline: eastern }),
        upstream({ airline: eastern, aircraft: null }),
        upstream(),
        upstream({ date: "2026-02-01", airline: { name: "Korean Air", icao: "KAL", iata: "KE" } }),
      ],
      today
    );
    expect(site.airlines).toEqual([
      { code: "MU", name: "China Eastern", flights: 2 },
      { code: "CA", name: "Air China", flights: 1 },
    ]);
    expect(site.aircraft).toEqual([{ code: "B77W", name: "Boeing 777-300ER", flights: 2 }]);
    expect(site.stats).toMatchObject({ airlines: 2, aircraftTypes: 1 });
  });

  it("drops flights it cannot place and totals only known durations", () => {
    const site = composeSite(
      [
        upstream({ duration: null }),
        upstream({ to: null }),
        upstream({ from: { ...SHA, iata: null, icao: null } }),
        upstream({ date: "2025" }),
      ],
      today
    );
    expect(site.stats.flights).toBe(1);
    expect(site.routes[0].minutes).toBeNull();
    expect(site.stats.minutes).toBe(0);
  });

  it("falls back to the ICAO code", () => {
    const site = composeSite([upstream({ to: { ...GMP, iata: null } })], today);
    expect(site.routes[0]).toMatchObject({ from: "RKSS", to: "SHA" });
  });
});
