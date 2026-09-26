/**
 * Every service, in the order /health lists them. Adding one is a
 * directory under src/services/ that default-exports a `Service`, plus a
 * line here — and a job in src/schedule.ts if its view polls an upstream.
 */

import type { Service } from "../lib/service";
import flights from "./flights";
import movies from "./movies";
import music from "./music";
import switchPlay from "./switch";
import tokens from "./tokens";

export const SERVICES = [tokens, switchPlay, flights, music, movies] as const satisfies readonly Service[];

export { flights, movies, music, switchPlay, tokens };
