// docs/specs/plugins/resource.md §1.1 / §3.1 — entry normalization, skills, time off.
/**
 * The ledger's entry half: creation, update, removal, skills, calendar and time-off management.
 * Hostless — a plain class over plain data, unit-testable without a plugin host.
 *
 * Mutators return `{ id, changed }` (or just whether something changed): a mutation that changes
 * nothing observable emits no store notification (§1.1).
 */
import type { ResourceId } from "@stargantt/plugin-data-store";
import type {
  ResourceKind,
  ResourcePoolEntry,
  ResourcePoolEntryInit,
  ResourceTimeOffInit,
  ResourceWorkCalendar,
} from "../../config";

export type { ResourceWorkCalendar };

/** Whether the value is a non-array object — the shape every init/filter parameter must have. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Filter for `entries()`. Members combine with AND. */
export interface ResourceFilter {
  kind?: ResourceKind;
  skills?: readonly string[];
  text?: string;
}

/** One dated non-working range (vacation, sick leave, …) on a resource. Half-open. */
export interface ResourceTimeOff {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly reason?: string;
}

const KINDS: readonly ResourceKind[] = ["person", "equipment", "material"];

interface Entry {
  id: ResourceId;
  name: string;
  kind: ResourceKind;
  capacity: number | undefined;
  skills: string[];
  calendar: ResourceWorkCalendar | undefined;
  costRate: number | undefined;
  billable: boolean;
  timeOff: ResourceTimeOff[];
}

function assign<K extends keyof Entry>(entry: Entry, key: K, value: Entry[K] | undefined): boolean {
  if (value === undefined || entry[key] === value) return false;
  entry[key] = value as Entry[K];
  return true;
}

function usableName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function usableId(value: unknown): ResourceId | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") return value;
  return undefined;
}

function normalizeSkills(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    const skill = usableName(raw);
    if (skill !== undefined && !out.includes(skill)) out.push(skill);
  }
  return out;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Structural equality over plain calendar data. A false negative only costs a spurious event. */
function sameCalendar(a: ResourceWorkCalendar, b: ResourceWorkCalendar | undefined): boolean {
  if (b === undefined) return false;
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function updateCalendar(entry: Entry, init: ResourcePoolEntryInit): boolean {
  if (!("calendar" in init)) return false;
  if (init.calendar === undefined) {
    const changed = entry.calendar !== undefined;
    entry.calendar = undefined;
    return changed;
  }
  if (!isPlainObject(init.calendar) || sameCalendar(init.calendar, entry.calendar)) return false;
  entry.calendar = init.calendar;
  return true;
}

function finiteInRange(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : undefined;
}

function usableSpan(init: { start?: unknown; end?: unknown }): { start: number; end: number } | undefined {
  const { start, end } = init;
  if (
    typeof start !== "number" ||
    !Number.isFinite(start) ||
    typeof end !== "number" ||
    !Number.isFinite(end) ||
    start >= end
  ) {
    return undefined;
  }
  return { start, end };
}

function toPublicEntry(entry: Entry): ResourcePoolEntry {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    ...(entry.capacity !== undefined ? { capacity: entry.capacity } : {}),
    skills: [...entry.skills],
    ...(entry.calendar !== undefined ? { calendar: entry.calendar } : {}),
    ...(entry.costRate !== undefined ? { costRate: entry.costRate } : {}),
    billable: entry.billable,
  };
}

/** The entry ledger: creation, update, removal, skills, calendar and time off. */
export class PoolEntries {
  private readonly byId = new Map<ResourceId, Entry>();
  private nextEntryId = 1;
  private nextTimeOffId = 1;

  has(id: ResourceId): boolean {
    return this.byId.has(id);
  }

  get(id: ResourceId): ResourcePoolEntry | undefined {
    const entry = this.byId.get(id);
    return entry === undefined ? undefined : toPublicEntry(entry);
  }

  entries(filter?: ResourceFilter): ResourcePoolEntry[] {
    const out: ResourcePoolEntry[] = [];
    const f: ResourceFilter | undefined = isPlainObject(filter) ? filter : undefined;
    const wantedSkills = normalizeSkills(f?.skills);
    const text = typeof f?.text === "string" ? f.text.trim().toLowerCase() : undefined;
    for (const entry of this.byId.values()) {
      if (f?.kind !== undefined && KINDS.includes(f.kind) && entry.kind !== f.kind) continue;
      if (wantedSkills !== undefined && !wantedSkills.every((s) => entry.skills.includes(s))) continue;
      if (text !== undefined && text !== "" && !entry.name.toLowerCase().includes(text)) continue;
      out.push(toPublicEntry(entry));
    }
    return out;
  }

  /** Creates or updates one entry; returns its id plus whether anything observable changed. */
  upsert(init: ResourcePoolEntryInit): { id: ResourceId; changed: boolean } | undefined {
    if (!isPlainObject(init)) return undefined;
    const id = usableId(init.id);
    const existing = id === undefined ? undefined : this.byId.get(id);
    if (existing === undefined) {
      const created = this.create(init, id);
      return created === undefined ? undefined : { id: created, changed: true };
    }
    return { id: existing.id, changed: this.update(existing, init) };
  }

  private create(init: ResourcePoolEntryInit, id: ResourceId | undefined): ResourceId | undefined {
    const name = usableName(init.name);
    if (name === undefined) return undefined;
    let entryId = id;
    if (entryId === undefined) {
      do entryId = `resource-${this.nextEntryId++}`;
      while (this.byId.has(entryId));
    }
    const cap = finiteInRange(init.capacity, 0);
    const entry: Entry = {
      id: entryId,
      name,
      kind: KINDS.includes(init.kind as ResourceKind) ? (init.kind as ResourceKind) : "person",
      capacity: cap !== undefined && cap > 0 ? cap : undefined,
      skills: normalizeSkills(init.skills) ?? [],
      calendar: isPlainObject(init.calendar) ? (init.calendar as ResourceWorkCalendar) : undefined,
      costRate: finiteInRange(init.costRate, 0),
      billable: typeof init.billable === "boolean" ? init.billable : true,
      timeOff: [],
    };
    this.byId.set(entryId, entry);
    if (Array.isArray(init.timeOff)) {
      for (const item of init.timeOff) this.addTimeOff(entryId, item);
    }
    return entryId;
  }

  private update(entry: Entry, init: ResourcePoolEntryInit): boolean {
    const capacity = "capacity" in init ? finiteInRange(init.capacity, 0) : undefined;
    let changed = assign(entry, "name", usableName(init.name));
    const kind = KINDS.includes(init.kind as ResourceKind) ? (init.kind as ResourceKind) : undefined;
    changed = assign(entry, "kind", kind) || changed;
    changed =
      assign(entry, "capacity", capacity !== undefined && capacity > 0 ? capacity : undefined) || changed;

    const skills = normalizeSkills(init.skills);
    if (skills !== undefined && !sameStrings(skills, entry.skills)) {
      entry.skills = skills;
      changed = true;
    }
    if (updateCalendar(entry, init)) changed = true;

    changed = assign(entry, "costRate", finiteInRange(init.costRate, 0)) || changed;
    const billable = typeof init.billable === "boolean" ? init.billable : undefined;
    changed = assign(entry, "billable", billable) || changed;

    if (Array.isArray(init.timeOff)) {
      for (const item of init.timeOff) {
        if (this.addTimeOff(entry.id, item) !== undefined) changed = true;
      }
    }
    return changed;
  }

  /** Removes one entry and its time off; reports whether it existed. */
  remove(id: ResourceId): boolean {
    return this.byId.delete(id);
  }

  addSkill(id: ResourceId, skill: string): boolean {
    const entry = this.byId.get(id);
    const tag = usableName(skill);
    if (entry === undefined || tag === undefined || entry.skills.includes(tag)) return false;
    entry.skills.push(tag);
    return true;
  }

  removeSkill(id: ResourceId, skill: string): boolean {
    const entry = this.byId.get(id);
    const tag = usableName(skill);
    if (entry === undefined || tag === undefined) return false;
    const index = entry.skills.indexOf(tag);
    if (index < 0) return false;
    entry.skills.splice(index, 1);
    return true;
  }

  setCalendar(id: ResourceId, calendar: ResourceWorkCalendar | undefined): boolean {
    const entry = this.byId.get(id);
    if (entry === undefined) return false;
    const next = isPlainObject(calendar) ? calendar : undefined;
    if (next === undefined ? entry.calendar === undefined : sameCalendar(next, entry.calendar)) {
      return false;
    }
    entry.calendar = next;
    return true;
  }

  timeOff(id: ResourceId): ResourceTimeOff[] {
    const entry = this.byId.get(id);
    if (entry === undefined) return [];
    return [...entry.timeOff].sort((a, b) => a.start - b.start);
  }

  addTimeOff(id: ResourceId, init: ResourceTimeOffInit): string | undefined {
    const entry = this.byId.get(id);
    if (entry === undefined || !isPlainObject(init)) return undefined;
    const span = usableSpan(init);
    if (span === undefined) return undefined;
    const { start, end } = span;
    let rangeId: string;
    if (typeof init.id === "string" && init.id !== "") {
      if (entry.timeOff.some((r) => r.id === init.id)) return undefined;
      rangeId = init.id;
    } else {
      do rangeId = `timeoff-${this.nextTimeOffId++}`;
      while (entry.timeOff.some((r) => r.id === rangeId));
    }
    const range: ResourceTimeOff = {
      id: rangeId,
      start,
      end,
      ...(typeof init.reason === "string" ? { reason: init.reason } : {}),
    };
    entry.timeOff.push(range);
    return rangeId;
  }

  removeTimeOff(id: ResourceId, timeOffId: string): boolean {
    const entry = this.byId.get(id);
    if (entry === undefined) return false;
    const index = entry.timeOff.findIndex((r) => r.id === timeOffId);
    if (index < 0) return false;
    entry.timeOff.splice(index, 1);
    return true;
  }

  /** Raw calendar + time off, for the calendar module's evaluation. */
  calendarOf(id: ResourceId): { calendar: ResourceWorkCalendar | undefined; timeOff: ResourceTimeOff[] } | undefined {
    const entry = this.byId.get(id);
    return entry === undefined ? undefined : { calendar: entry.calendar, timeOff: entry.timeOff };
  }
}
