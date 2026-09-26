import type { AirTrailAirport, AirTrailFlight } from "../../src/services/flights/airtrail";

export const PEK: AirTrailAirport = {
  icao: "ZBAA",
  iata: "PEK",
  lat: 40.077349,
  lon: 116.596702,
  name: "Beijing Capital Intl.",
  municipality: "Beijing",
  country: "CN",
};

export const SHA: AirTrailAirport = {
  icao: "ZSSS",
  iata: "SHA",
  lat: 31.198104,
  lon: 121.33426,
  name: "Shanghai Hongqiao Intl.",
  municipality: "Shanghai (Minhang)",
  country: "CN",
};

export const GMP: AirTrailAirport = {
  icao: "RKSS",
  iata: "GMP",
  lat: 37.5583,
  lon: 126.791,
  name: "Gimpo Intl.",
  municipality: "Seoul",
  country: "KR",
};

/** A flight as AirTrail returns it, secrets and all. */
export function upstream(overrides: Partial<AirTrailFlight> & Record<string, unknown> = {}) {
  return {
    date: "2025-10-09",
    departure: "2025-10-09T04:27:00.000+00:00",
    datePrecision: "day",
    duration: 7080,
    flightNumber: "CCA1502",
    note: "PNR: JYV0WB",
    aircraftReg: "B-2037",
    departureGate: "50",
    from: SHA,
    to: PEK,
    airline: { name: "Air China", icao: "CCA", iata: "CA" },
    aircraft: { name: "Boeing 777-300ER", icao: "B77W" },
    passengers: [{ userId: "u1", seatNumber: "57L", seatClass: "economy" }],
    ...overrides,
  } as AirTrailFlight;
}
