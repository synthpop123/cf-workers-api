/**
 * The primitives every upstream narrower is written in. Each service
 * narrows its own upstream by hand, field by field (an upstream rename
 * must fail a composition, never change a contract silently); these are
 * only the type tests those narrowers share.
 */

/** A JSON object: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A finite number — never NaN or ±Infinity. */
export const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Trimmed text, or null for anything else (blank included). */
export const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
