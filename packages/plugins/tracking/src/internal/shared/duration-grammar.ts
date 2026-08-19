// docs/specs/plugins/tracking.md §2.5 — the shared duration-entry grammar the bulk
// progress panel's remaining-work field accepts: a bare number means days; a `d`/`h`/`m`/`s` suffix
// (optionally preceded by whitespace) picks the unit, and the number itself may carry a decimal
// fraction. Unparsable text is the caller's cue to leave the stored value untouched.
import { MS_DAY, MS_HOUR, MS_MINUTE, MS_SECOND } from "@stargantt/sdk";

const GRAMMAR = /^\s*(\d+(?:\.\d+)?)\s*([dhms])?\s*$/;

const UNIT_MS: Readonly<Record<"d" | "h" | "m" | "s", number>> = {
  d: MS_DAY,
  h: MS_HOUR,
  m: MS_MINUTE,
  s: MS_SECOND,
};

/** Parses a duration-entry field per the §2.5 grammar; `undefined` for anything it cannot read. */
export function parseDurationInput(text: string): number | undefined {
  if (typeof text !== "string") return undefined;
  const match = GRAMMAR.exec(text);
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? "d") as "d" | "h" | "m" | "s";
  return value * UNIT_MS[unit];
}
