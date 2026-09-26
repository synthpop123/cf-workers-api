/**
 * The slice of AirTrail's `GET /api/flight/list` this Worker reads, and the
 * one call that fetches it. Upstream carries far more — PNRs in `note`,
 * seat numbers, gates, registrations, passenger ids, and per-flight
 * detail the page does not show (flight numbers, departure times) — and
 * none of it is typed here, so none of it can leak into the payload by
 * accident.
 */

import type { Env } from "../../env";

export interface AirTrailAirport {
  icao: string | null;
  iata: string | null;
  lat: number;
  lon: number;
  name: string;
  municipality: string | null;
  country: string | null;
}

export interface AirTrailFlight {
  date: string;
  /** Seconds, gate to gate. */
  duration: number | null;
  from: AirTrailAirport | null;
  to: AirTrailAirport | null;
  airline: { name: string; icao: string | null; iata: string | null } | null;
  aircraft: { name: string; icao: string | null } | null;
}

const TIMEOUT_MS = 10_000;

export async function fetchFlights(env: Env): Promise<AirTrailFlight[]> {
  const response = await fetch(new URL("/api/flight/list", env.AIRTRAIL_URL), {
    headers: {
      Authorization: `Bearer ${env.AIRTRAIL_API_KEY}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`AirTrail answered ${response.status}`);
  const body = (await response.json()) as { success?: boolean; flights?: unknown };
  if (!Array.isArray(body.flights)) throw new Error("AirTrail payload has no flights");
  return body.flights as AirTrailFlight[];
}
