/**
 * Every service, in the order /health lists them. Adding one is a
 * directory under src/services/ that default-exports a `Service`, plus a
 * line here — and a job in src/schedule.ts if its view polls an upstream.
 */

import type { Service } from "../lib/service";
import flights from "./flights";
import memos from "./memos";
import movies from "./movies";
import music from "./music";
import now from "./now";
import switchPlay from "./switch";
import tokens from "./tokens";

export const SERVICES = [
  tokens,
  switchPlay,
  flights,
  music,
  movies,
  memos,
  now,
] as const satisfies readonly Service[];

export { flights, memos, movies, music, now, switchPlay, tokens };
