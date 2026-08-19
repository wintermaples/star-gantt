/**
 * IANA time-zone arithmetic for the display-time-zone mode.
 *
 * The store keeps every instant in epoch milliseconds UTC; when a display time zone is
 * configured, the header's calendar boundaries and labels move to that zone's wall clock. The
 * conversion between an instant and its wall clock is computed here, through
 * `Intl.DateTimeFormat.formatToParts` — the only zone database the platform exposes — so the
 * plugin stays free of any bundled time-zone data.
 *
 * Internal: not part of the published surface.
 */

/** One formatter per zone, memoised: construction is the expensive part of `formatToParts`. */
const partFormatters = new Map<string, Intl.DateTimeFormat>();

// docs/specs/plugins/view.md — header ticks, `unitBoundaries` and the export
// tiles floor and advance the same handful of boundary instants once per paint, so without a memo
// every frame re-issues `formatToParts` for instants already resolved. The memo is keyed by the
// exact instant (not by day or by transition) because that is what the callers repeat, and it is
// bounded so a long-lived chart cannot grow it without limit.
/** Largest number of instants memoised per zone before that zone's memo is dropped wholesale. */
const OFFSET_MEMO_LIMIT = 8192;

/** Per-zone instant → UTC-offset memo. Keyed by zone, so a different zone never shares entries. */
const offsetMemos = new Map<string, Map<number, number>>();

/** How many live chart instances currently use each zone; a zone at zero drops its memo. */
const zoneRefCounts = new Map<string, number>();

// docs/specs/plugins/view.md — the memo is "cleared on zone change": a zone is
// fixed per instance, so zone change means instance turnover, and the memo for a zone must not
// outlive the last instance displaying it. The plugin retains its zone at setup and releases it
// through `ctx.own`, so disposal is core-owned like every other resource.
/**
 * Marks a display time zone as in use by one chart instance and returns the matching release.
 *
 * Releasing the last retention of a zone drops that zone's conversion memo, returning its memory;
 * results are unaffected, since the memo is a pure cache. Calling the returned function more than
 * once is a no-op after the first call.
 */
export function retainZone(timeZone: string): () => void {
  zoneRefCounts.set(timeZone, (zoneRefCounts.get(timeZone) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = zoneRefCounts.get(timeZone) ?? 0;
    if (count <= 1) {
      zoneRefCounts.delete(timeZone);
      offsetMemos.delete(timeZone);
    } else {
      zoneRefCounts.set(timeZone, count - 1);
    }
  };
}

/** Test-only view of how many instants a zone's memo currently holds. */
export function zoneOffsetMemoSize(timeZone: string): number {
  return offsetMemos.get(timeZone)?.size ?? 0;
}

function offsetMemo(timeZone: string): Map<number, number> {
  let memo = offsetMemos.get(timeZone);
  if (memo === undefined) {
    memo = new Map<number, number>();
    offsetMemos.set(timeZone, memo);
  }
  return memo;
}

/**
 * Drops every memoised offset — for tests, and for a host that wants the memo's memory back.
 *
 * Purely an optimisation cache: clearing it changes no result, only how many platform zone
 * lookups the next conversions perform.
 */
export function clearZoneOffsetMemo(): void {
  offsetMemos.clear();
}

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partFormatters.get(timeZone);
  if (f === undefined) {
    // en-US with fixed numeric fields: the parts are parsed back into numbers, so the locale must
    // be one whose digits are ASCII and whose fields are unambiguous.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    });
    partFormatters.set(timeZone, f);
  }
  return f;
}

// docs/specs/plugins/view.md — an unusable
// `displayTimeZone` degrades to the default (UTC display) silently rule 3.
/**
 * The configured display time zone, normalized: a string `Intl.DateTimeFormat` accepts, other
 * than plain UTC, comes back verbatim; anything else — a non-string, an identifier the platform
 * does not know, or `"UTC"` itself, which equals the default — comes back `undefined`, meaning
 * "no zone conversion".
 */
export function normalizeTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  // UTC display is the plugin's default path; normalizing it away keeps that path Intl-free.
  return resolved === "UTC" ? undefined : value;
}

/**
 * The zone's offset from UTC at instant `t`, in milliseconds; positive east of Greenwich.
 *
 * Defined so that `t + zoneOffset(tz, t)` is the epoch value whose UTC fields equal the zone's
 * wall-clock fields at `t` — the "wall time" the calendar arithmetic floors and advances on.
 *
 * Results are memoised per zone and instant, bounded at `OFFSET_MEMO_LIMIT` entries per zone;
 * exceeding the bound drops that zone's memo and starts it over, so repeated per-paint boundary
 * arithmetic stays cheap without unbounded growth.
 */
export function zoneOffset(timeZone: string, t: number): number {
  const memo = offsetMemo(timeZone);
  const hit = memo.get(t);
  // `undefined` cannot be a stored value — offsets are always numbers — so a miss is unambiguous.
  if (hit !== undefined) return hit;
  const value = computeZoneOffset(timeZone, t);
  // Wholesale eviction rather than LRU: the access pattern is a sliding window of boundaries, so
  // the refill after a clear is the same work an LRU miss would do, without the bookkeeping.
  if (memo.size >= OFFSET_MEMO_LIMIT) memo.clear();
  memo.set(t, value);
  return value;
}

/** The uncached computation: one `formatToParts` call, parsed back into a wall-clock instant. */
function computeZoneOffset(timeZone: string, t: number): number {
  const parts = partsFormatter(timeZone).formatToParts(t);
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let era = "AD";
  for (const p of parts) {
    switch (p.type) {
      case "era":
        era = p.value;
        break;
      case "year":
        year = Number(p.value);
        break;
      case "month":
        month = Number(p.value);
        break;
      case "day":
        day = Number(p.value);
        break;
      case "hour":
        hour = Number(p.value);
        break;
      case "minute":
        minute = Number(p.value);
        break;
      case "second":
        second = Number(p.value);
        break;
      default:
        break;
    }
  }
  // BC years count backwards and have no year 0 in the Gregorian era scheme.
  const signedYear = era === "BC" || era === "B" ? 1 - year : year;
  // Zone offsets are whole seconds, so comparing at second precision loses nothing; `Date.UTC`
  // absorbs the hour-24 midnight reading some engines produce in h23 mode.
  const wall = Date.UTC(signedYear, month - 1, day, hour, minute, second);
  return wall - Math.floor(t / 1000) * 1000;
}

/** The zone's wall-clock reading of instant `t`, as epoch-style milliseconds. */
export function toWall(timeZone: string, t: number): number {
  return t + zoneOffset(timeZone, t);
}

/**
 * The instant whose wall clock in the zone reads `w` (epoch-style milliseconds).
 *
 * The inverse of `toWall`, resolved with the standard two-pass offset probe so it stays correct
 * across DST transitions: a wall time skipped by a spring-forward maps to the instant the clocks
 * jumped to, and a wall time repeated by a fall-back maps to one of its two instants.
 */
export function fromWall(timeZone: string, w: number): number {
  const guess = w - zoneOffset(timeZone, w);
  return w - zoneOffset(timeZone, guess);
}
