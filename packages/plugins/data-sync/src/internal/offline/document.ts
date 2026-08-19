// docs/specs/plugins/data-sync.md §4.1 / §4.3
/**
 * `PersistedDocument` assembly/validation, plus the `storage/snapshot` extension point's
 * capture/apply walks (§4.3). Pure and hostless — `wire.ts` owns the extension point itself
 * (`ctx.defineExtensionPoint`) and hands this module the current contribution list.
 */
import type { PersistedDocument, SnapshotContribution } from "../../types";

/**
 * Builds a persisted document from a store snapshot, stamping the save time. `plugins` is
 * included only when given and non-empty, so a save with no `storage/snapshot` contributions (or
 * none that captured anything) writes a document identical in shape to one without that field.
 */
export function toDocument(
  snapshot: { tasks: unknown[]; links: unknown[]; resources: unknown[]; assignments: unknown[]; calendars: unknown[] },
  now: number,
  plugins?: Record<string, unknown>,
): PersistedDocument {
  const doc: PersistedDocument = {
    tasks: [...snapshot.tasks],
    links: [...snapshot.links],
    resources: [...snapshot.resources],
    assignments: [...snapshot.assignments],
    calendars: [...snapshot.calendars],
    savedAt: now,
  };
  if (plugins !== undefined) doc.plugins = plugins;
  return doc;
}

/**
 * Validates a value read back from storage. Returns it as a `PersistedDocument` when it carries
 * all five array lists, `undefined` otherwise (a foreign or corrupted record is treated exactly
 * like no record at all; `plugins` plays no part in this test).
 */
export function asDocument(value: unknown): PersistedDocument | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const doc = value as PersistedDocument;
  const lists = [doc.tasks, doc.links, doc.resources, doc.assignments, doc.calendars];
  if (!lists.every(Array.isArray)) return undefined;
  return doc;
}

/**
 * De-duplicates `contributions` by id (first wins), reporting a duplicate through `fault` under
 * `where` (the caller's phase — `"snapshot-capture"` or `"snapshot-apply"`).
 */
export function uniqueContributions(
  contributions: readonly SnapshotContribution[],
  where: string,
  fault: (where: string, error: unknown) => void,
): SnapshotContribution[] {
  const seen = new Set<string>();
  const unique: SnapshotContribution[] = [];
  for (const c of contributions) {
    if (seen.has(c.id)) {
      fault(where, new Error(`duplicate storage/snapshot contribution id "${c.id}"`));
      continue;
    }
    seen.add(c.id);
    unique.push(c);
  }
  return unique;
}

/**
 * Captures every currently registered contribution's state, in registration order (§4.3). Each
 * `capture()` is foreign code, guarded individually so one contributor's throw cannot drop the
 * rest. Returns `undefined` when nothing was captured, so a save with no contributions writes a
 * document identical in shape to one from before this feature existed.
 */
export function captureContributions(
  contributions: readonly SnapshotContribution[],
  fault: (where: string, error: unknown) => void,
): Record<string, unknown> | undefined {
  let plugins: Record<string, unknown> | undefined;
  for (const c of uniqueContributions(contributions, "snapshot-capture", fault)) {
    let value: unknown;
    try {
      value = c.capture();
    } catch (error) {
      fault(`snapshot-capture:${c.id}`, error);
      continue;
    }
    if (value === undefined) continue;
    plugins ??= {};
    plugins[c.id] = value;
  }
  return plugins;
}

/**
 * Applies `plugins` to every currently registered contribution whose id has an entry, in
 * registration order, AFTER `DataService.load()` has already replaced the five lists (§4.3).
 * Returns the ids whose `apply()` completed without throwing.
 */
export function applyContributions(
  contributions: readonly SnapshotContribution[],
  plugins: Record<string, unknown> | undefined,
  fault: (where: string, error: unknown) => void,
): string[] {
  if (plugins === undefined) return [];
  const restored: string[] = [];
  for (const c of uniqueContributions(contributions, "snapshot-apply", fault)) {
    if (!Object.prototype.hasOwnProperty.call(plugins, c.id)) continue;
    try {
      c.apply(plugins[c.id]);
    } catch (error) {
      fault(`snapshot-apply:${c.id}`, error);
      continue;
    }
    restored.push(c.id);
  }
  return restored;
}
