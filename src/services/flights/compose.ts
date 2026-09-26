/**
 * The pure layer: AirTrail flights in, the public /flights/site body out. No
 * bindings, no clock — `today` is always passed in — so this is where the
 * unit tests live.
 *
 * What ships is the map, not the log: airports, the routes between them
 * and totals, with no single flight in it — no flight number and no
 * date but the first and the latest. And never who or which seat: the
 * payload is built field by field from the typed slice in `airtrail.ts`,
 * so a PNR in a note or a seat number has no path into it.
 */

import type { AirTrailAirport, AirTrailFlight } from "./airtrail";

export const SITE_VERSION = 1;

export interface SiteAirport {
  /** IATA when it has one, ICAO otherwise — the code the page prints. */
  code: string;
  name: string;
  city: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  lat: number;
  lon: number;
  /** Departures plus arrivals among flights already flown. */
  visits: number;
}

export interface SiteRoute {
  /** The pair in code order: a route is flown both ways and drawn once. */
  from: string;
  to: string;
  /** Flights flown along it, either direction. */
  flights: number;
  /** Flights logged ahead of `today` along it. */
  upcoming: number;
  /** Great-circle distance between the two airports. */
  km: number;
  /** Mean gate-to-gate minutes over the flights whose duration is known. */
  minutes: number | null;
}

/** An airline or aircraft type, and how many flights it carried. */
export interface SiteCount {
  code: string | null;
  name: string;
  flights: number;
}

export interface SiteStats {
  flights: number;
  /** Logged ahead of `today`, not yet flown. */
  upcoming: number;
  km: number;
  /** Over the flights whose duration is known. */
  minutes: number;
  airports: number;
  countries: number;
  airlines: number;
  aircraftTypes: number;
  /** Distinct airport pairs, either direction. */
  routes: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface Site {
  schemaVersion: number;
  today: string;
  stats: SiteStats;
  /** Most visited first. */
  airports: SiteAirport[];
  /** Most flown first, then longest. */
  routes: SiteRoute[];
  /** Most flown first; flown flights only. */
  airlines: SiteCount[];
  aircraft: SiteCount[];
}

const EARTH_RADIUS_KM = 6371;

export function greatCircleKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h))));
}

const airportCode = (airport: AirTrailAirport): string | null =>
  airport.iata?.trim() || airport.icao?.trim() || null;

const hasPlace = (airport: AirTrailAirport | null): airport is AirTrailAirport =>
  airport !== null &&
  Number.isFinite(airport.lat) &&
  Number.isFinite(airport.lon) &&
  airportCode(airport) !== null;

/** `Shanghai (Minhang)` → `Shanghai`: the district is AirTrail's detail,
 *  and a label on a globe has room for the city only. */
const cityOf = (municipality: string | null): string | null =>
  municipality?.replace(/\s*\([^)]*\)\s*$/, "").trim() || null;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const minutesOf = (flight: AirTrailFlight): number | null =>
  typeof flight.duration === "number" && flight.duration > 0
    ? Math.round(flight.duration / 60)
    : null;

/** Tally by name, most first; ties in name order so the output is stable. */
function tally(
  items: ({ name: string; code: string | null } | null)[]
): SiteCount[] {
  const counts = new Map<string, SiteCount>();
  for (const item of items) {
    const name = item?.name.trim();
    if (!item || !name) continue;
    const entry = counts.get(name) ?? { code: item.code, name, flights: 0 };
    entry.flights += 1;
    counts.set(name, entry);
  }
  return [...counts.values()].sort(
    (a, b) => b.flights - a.flights || a.name.localeCompare(b.name)
  );
}

export function composeSite(upstream: AirTrailFlight[], today: string): Site {
  const airports = new Map<string, SiteAirport>();
  const place = (airport: AirTrailAirport): SiteAirport => {
    const code = airportCode(airport) as string;
    let entry = airports.get(code);
    if (!entry) {
      entry = {
        code,
        name: airport.name,
        city: cityOf(airport.municipality),
        country: airport.country?.trim() || null,
        lat: airport.lat,
        lon: airport.lon,
        visits: 0,
      };
      airports.set(code, entry);
    }
    return entry;
  };

  const rows = upstream.filter(
    (flight) =>
      typeof flight.date === "string" &&
      DATE_RE.test(flight.date) &&
      hasPlace(flight.from) &&
      hasPlace(flight.to)
  );

  const routes = new Map<string, SiteRoute & { timed: number; total: number }>();
  const flown: AirTrailFlight[] = [];
  let upcoming = 0;
  let km = 0;
  let minutes = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  for (const flight of rows) {
    const a = place(flight.from as AirTrailAirport);
    const b = place(flight.to as AirTrailAirport);
    const [from, to] = [a, b].sort((x, y) => x.code.localeCompare(y.code));
    const key = `${from.code}-${to.code}`;
    let route = routes.get(key);
    if (!route) {
      route = {
        from: from.code,
        to: to.code,
        flights: 0,
        upcoming: 0,
        km: greatCircleKm(from, to),
        minutes: null,
        timed: 0,
        total: 0,
      };
      routes.set(key, route);
    }

    if (flight.date > today) {
      upcoming += 1;
      route.upcoming += 1;
      continue;
    }
    flown.push(flight);
    a.visits += 1;
    b.visits += 1;
    route.flights += 1;
    km += route.km;
    const time = minutesOf(flight);
    if (time !== null) {
      minutes += time;
      route.timed += 1;
      route.total += time;
    }
    if (!firstDate || flight.date < firstDate) firstDate = flight.date;
    if (!lastDate || flight.date > lastDate) lastDate = flight.date;
  }

  const visited = [...airports.values()].filter((airport) => airport.visits > 0);
  const airlines = tally(
    flown.map((flight) =>
      flight.airline
        ? {
            name: flight.airline.name,
            code: flight.airline.iata?.trim() || flight.airline.icao?.trim() || null,
          }
        : null
    )
  );
  const aircraft = tally(
    flown.map((flight) =>
      flight.aircraft
        ? { name: flight.aircraft.name, code: flight.aircraft.icao?.trim() || null }
        : null
    )
  );

  return {
    schemaVersion: SITE_VERSION,
    today,
    stats: {
      flights: flown.length,
      upcoming,
      km,
      minutes,
      airports: visited.length,
      countries: new Set(
        visited.map((airport) => airport.country).filter((country) => country !== null)
      ).size,
      airlines: airlines.length,
      aircraftTypes: aircraft.length,
      routes: [...routes.values()].filter((route) => route.flights > 0).length,
      firstDate,
      lastDate,
    },
    airports: [...airports.values()].sort(
      (a, b) => b.visits - a.visits || a.code.localeCompare(b.code)
    ),
    routes: [...routes.values()]
      .map(({ timed, total, ...route }) => ({
        ...route,
        minutes: timed > 0 ? Math.round(total / timed) : null,
      }))
      .sort(
        (a, b) =>
          b.flights - a.flights ||
          b.km - a.km ||
          `${a.from}-${a.to}`.localeCompare(`${b.from}-${b.to}`)
      ),
    airlines,
    aircraft,
  };
}
