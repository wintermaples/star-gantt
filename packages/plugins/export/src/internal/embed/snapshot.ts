// docs/specs/plugins/export.md §2.2 — snapshot token encoding/decoding and URL handling. Hostless:
// pure functions, unit-testable without a plugin host.
/**
 * A snapshot token is `{ schema: "stargantt/snapshot/v1", data: <project JSON> }`, UTF-8 encoded
 * then base64url encoded (RFC 4648 §5, unpadded).
 */

export const SNAPSHOT_SCHEMA = "stargantt/snapshot/v1";

/** The five project lists `DataService.toJSON()` produces and `load()` accepts. */
export interface SnapshotData {
  tasks: unknown[];
  links: unknown[];
  calendars: unknown[];
  resources: unknown[];
  assignments: unknown[];
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * 256-entry char-code → 6-bit-value lookup table for {@link decodeBase64Url}, built once at module
 * load. `255` marks a char code outside the base64url alphabet (a real Uint8Array has no room for
 * `-1`, so `255` is the invalid sentinel instead).
 */
const B64URL_DECODE = ((): Uint8Array => {
  const table = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64URL.length; i += 1) table[B64URL.charCodeAt(i)] = i;
  return table;
})();

/**
 * Ceiling on a token's *decoded* byte size (§2.2's "trust boundary") — generous, but bounded, so a
 * hostile token can't force an unbounded allocation.
 */
const MAX_DECODED_BYTES = 4 * 1024 * 1024;

/** Unpadded base64url of a byte sequence (RFC 4648 §5) — the alphabet that survives URLs verbatim. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64URL[a >> 2]! + B64URL[((a & 3) << 4) | (b >> 4)]!;
    if (i + 1 < bytes.length) out += B64URL[((b & 15) << 2) | (c >> 6)]!;
    if (i + 2 < bytes.length) out += B64URL[c & 63]!;
  }
  return out;
}

/**
 * Inverse of {@link encodeBase64Url}; `undefined` for text outside the alphabet, bad length, or a
 * decoded size past {@link MAX_DECODED_BYTES}. Decodes straight into a single pre-sized
 * `Uint8Array` — the exact output length is known from `text.length` up front, so there is no
 * intermediate `number[]` and no unbounded allocation for a hostile token.
 */
export function decodeBase64Url(text: string): Uint8Array | undefined {
  const n = text.length;
  const rem = n % 4;
  if (rem === 1) return undefined;
  const decodedLength = (n >> 2) * 3 + (rem === 0 ? 0 : rem === 2 ? 1 : 2);
  if (decodedLength > MAX_DECODED_BYTES) return undefined;
  const bytes = new Uint8Array(decodedLength);
  let outIdx = 0;
  for (let i = 0; i < n; i += 4) {
    const has2 = i + 2 < n;
    const has3 = i + 3 < n;
    const code0 = text.charCodeAt(i);
    const code1 = text.charCodeAt(i + 1);
    const code2 = has2 ? text.charCodeAt(i + 2) : 0;
    const code3 = has3 ? text.charCodeAt(i + 3) : 0;
    // A char code past the 256-entry table's range would index out of bounds (`undefined`, not a
    // real entry) and slip past the `=== 255` sentinel check below — reject it explicitly first.
    if (code0 > 255 || code1 > 255 || code2 > 255 || code3 > 255) return undefined;
    const c0 = B64URL_DECODE[code0]!;
    const c1 = B64URL_DECODE[code1]!;
    const c2 = has2 ? B64URL_DECODE[code2]! : 0;
    const c3 = has3 ? B64URL_DECODE[code3]! : 0;
    if (c0 === 255 || c1 === 255 || c2 === 255 || c3 === 255) return undefined;
    bytes[outIdx++] = ((c0 << 2) | (c1 >> 4)) & 0xff;
    if (has2) bytes[outIdx++] = ((c1 << 4) | (c2 >> 2)) & 0xff;
    if (has3) bytes[outIdx++] = ((c2 << 6) | c3) & 0xff;
  }
  return bytes;
}

/** Serializes project data into a snapshot token. */
export function encodeSnapshot(data: SnapshotData): string {
  const json = JSON.stringify({ schema: SNAPSHOT_SCHEMA, data });
  return encodeBase64Url(new TextEncoder().encode(json));
}

/**
 * A decoded snapshot's task entries, plus how many were dropped by {@link decodeSnapshot}'s
 * validation (§2.2): a snapshot URL carries the same trust as the page linking to it, but is still
 * untrusted *data* handed to `DataService.load()`, so obviously-broken task entries are dropped
 * rather than corrupting the store with an unusable id or a non-numeric date.
 */
export interface DecodedSnapshot {
  data: SnapshotData;
  /** Task entries dropped for failing validation (§2.2); `0` when every entry passed. */
  droppedTasks: number;
}

/**
 * `true` when `entry` has a usable `id` (`string | number`) and, when present, finite `start` /
 * `end` numbers — the minimal validation `decodeSnapshot` applies to each task entry (§2.2).
 * Absent `start`/`end` pass (a task may legitimately omit either); a present-but-non-finite value
 * fails.
 */
function isValidTaskEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const t = entry as { id?: unknown; start?: unknown; end?: unknown };
  if (typeof t.id !== "string" && typeof t.id !== "number") return false;
  if (t.start !== undefined && !Number.isFinite(t.start)) return false;
  if (t.end !== undefined && !Number.isFinite(t.end)) return false;
  return true;
}

/**
 * Decodes a snapshot token back into project data. Returns `undefined` — never throws — for
 * anything unusable: not a string, not base64url, not UTF-8 JSON, or JSON without the schema tag.
 *
 * Task entries additionally go through minimal validation (§2.2): an entry whose `id` is not
 * `string | number`, or whose present `start` / `end` is not a finite number, is dropped rather
 * than rejecting the whole token — a malformed entry is an authoring bug in one task, not grounds
 * to discard an otherwise-usable snapshot. `droppedTasks` reports how many were dropped.
 */
export function decodeSnapshot(token: string): DecodedSnapshot | undefined {
  if (typeof token !== "string" || token === "") return undefined;
  const bytes = decodeBase64Url(token);
  if (bytes === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const doc = parsed as { schema?: unknown; data?: unknown };
  if (doc.schema !== SNAPSHOT_SCHEMA) return undefined;
  const data = doc.data;
  if (data === null || typeof data !== "object") return undefined;
  const lists = data as Partial<Record<keyof SnapshotData, unknown>>;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const rawTasks = list(lists.tasks);
  const tasks = rawTasks.filter(isValidTaskEntry);
  return {
    data: {
      tasks,
      links: list(lists.links),
      calendars: list(lists.calendars),
      resources: list(lists.resources),
      assignments: list(lists.assignments),
    },
    droppedTasks: rawTasks.length - tasks.length,
  };
}

/**
 * Attaches `<param>=<token>` to a URL's fragment. An existing `<param>=…` pair in the fragment is
 * replaced; other fragment content is preserved with `&` joining. An empty base yields the bare
 * fragment.
 */
export function buildSnapshotUrl(base: string, param: string, token: string): string {
  const hashAt = base.indexOf("#");
  const head = hashAt < 0 ? base : base.slice(0, hashAt);
  const fragment = hashAt < 0 ? "" : base.slice(hashAt + 1);
  const kept = fragment.split("&").filter((part) => part !== "" && !part.startsWith(`${param}=`));
  kept.push(`${param}=${token}`);
  return `${head}#${kept.join("&")}`;
}

/**
 * Extracts the snapshot token from a URL: the fragment is searched first, then the query string.
 * Returns `undefined` when the parameter is absent or its value is empty.
 */
export function extractSnapshotToken(url: string, param: string): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  const hashAt = url.indexOf("#");
  const fragment = hashAt < 0 ? "" : url.slice(hashAt + 1);
  const head = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = head.indexOf("?");
  const query = queryAt < 0 ? "" : head.slice(queryAt + 1);
  for (const section of [fragment, query]) {
    for (const part of section.split("&")) {
      if (part.startsWith(`${param}=`)) {
        const value = part.slice(param.length + 1);
        if (value !== "") return value;
      }
    }
  }
  return undefined;
}
