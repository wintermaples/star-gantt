import type {
  Assignment,
  CalendarId,
  FieldMapping,
  Link,
  LinkId,
  LinkType,
  Resource,
  ResourceId,
  Task,
  TaskId,
} from "./types";

type RawRecord = Record<string, unknown>;
type FieldSpec = string | ((raw: unknown) => unknown);
type Mapping = Partial<Record<string, FieldSpec>> | undefined;

/**
 * Widens a caller's mapping to the row-agnostic form the normalizers read.
 *
 * A mapping function is contravariant in its argument, so a mapping written for a concrete row type
 * cannot simply be *assigned* to one that hands its functions an `unknown` row. Every normalizer
 * here reads rows as `unknown`, so the widening is asserted once, at this single boundary, instead
 * of by an `any` in the published type.
 */
export function asRawMapping<TRaw>(
  mapping: FieldMapping<TRaw> | undefined,
): FieldMapping<unknown> | undefined {
  return mapping as FieldMapping<unknown> | undefined;
}

const LINK_TYPES = new Set<string>(["FS", "SS", "FF", "SF"]);
const TASK_TYPES = new Set<string>(["task", "summary", "milestone"]);

/**
 * Reads one field out of a raw object. A mapping entry is either the name of the source property
 * or a function computing the value. With no entry the field falls back to the same-named property
 * of the raw object, so already-normalized data loads without a mapping at all.
 */
export function resolve(raw: unknown, field: string, mapping: Mapping): unknown {
  const spec = mapping?.[field];
  if (typeof spec === "function") return spec(raw);
  const src = (raw ?? {}) as RawRecord;
  if (typeof spec === "string") return src[spec];
  return src[field];
}

/**
 * Decides whether a raw item describes a link rather than a task.
 *
 * `load()` takes one flat array that may mix tasks and links, with a single mapping describing
 * both. An item is read as a link when the link mapping resolves both endpoints, and as a task
 * otherwise.
 */
export function isLinkRaw(raw: unknown, mapping: FieldMapping | undefined): boolean {
  const link = mapping?.link;
  return (
    resolve(raw, "sourceId", link) !== undefined && resolve(raw, "targetId", link) !== undefined
  );
}

function asId(v: unknown): TaskId | undefined {
  return typeof v === "string" || typeof v === "number" ? v : undefined;
}

/**
 * Boundary coercion for the two time fields: time stays epoch ms internally, and `Date` is
 * accepted only at this boundary — `Number(date)` yields the epoch ms.
 */
function asTime(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Clamps a value into the 0..1 range that `Task.progress` is documented to hold. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function normalizeTask(
  raw: unknown,
  mapping: FieldMapping | undefined,
  fallbackId: TaskId,
  fallbackOrderKey: string,
): Task {
  const m = mapping?.task;
  const start = asTime(resolve(raw, "start", m), 0);
  const orderKey = resolve(raw, "orderKey", m);
  const progress = resolve(raw, "progress", m);
  const type = resolve(raw, "type", m);
  const constraint = resolve(raw, "constraint", m);
  const calendarId = resolve(raw, "calendarId", m);
  const meta = resolve(raw, "meta", m);
  const name = resolve(raw, "name", m);

  const task: Task = {
    id: asId(resolve(raw, "id", m)) ?? fallbackId,
    parentId: asId(resolve(raw, "parentId", m)) ?? null,
    name: name === undefined || name === null ? "" : String(name),
    start,
    end: asTime(resolve(raw, "end", m), start),
    orderKey: typeof orderKey === "string" ? orderKey : fallbackOrderKey,
  };
  if (typeof progress === "number") task.progress = clamp01(progress);
  if (typeof type === "string" && TASK_TYPES.has(type)) {
    task.type = type as NonNullable<Task["type"]>;
  }
  if (constraint !== undefined && constraint !== null && typeof constraint === "object") {
    task.constraint = constraint as NonNullable<Task["constraint"]>;
  }
  const cal = asId(calendarId);
  if (cal !== undefined) task.calendarId = cal as CalendarId;
  if (meta !== undefined && meta !== null && typeof meta === "object") {
    task.meta = meta as Record<string, unknown>;
  }
  return task;
}

/**
 * Returns `undefined` when either endpoint does not resolve to a `TaskId`. Storing the link with a
 * fabricated `""` endpoint instead would leave a dangling link and a phantom `linksByTask` bucket.
 */
export function normalizeLink(
  raw: unknown,
  mapping: FieldMapping | undefined,
  fallbackId: LinkId,
): Link | undefined {
  const m = mapping?.link;
  const sourceId = asId(resolve(raw, "sourceId", m));
  const targetId = asId(resolve(raw, "targetId", m));
  if (sourceId === undefined || targetId === undefined) return undefined;

  const type = resolve(raw, "type", m);
  const lag = resolve(raw, "lag", m);

  const link: Link = {
    id: asId(resolve(raw, "id", m)) ?? fallbackId,
    sourceId,
    targetId,
    type: typeof type === "string" && LINK_TYPES.has(type) ? (type as LinkType) : "FS",
  };
  // `lag: 0` is normalized to an absent field and a non-finite lag is dropped as unusable,
  // matching the command builders — a stored link never carries a zero or non-finite lag
  // (a zero lag and an absent one describe the same dependency).
  if (typeof lag === "number" && Number.isFinite(lag) && lag !== 0) link.lag = lag;
  return link;
}

export function normalizeResource(
  raw: unknown,
  mapping: FieldMapping | undefined,
  fallbackId: ResourceId,
): Resource {
  const m = mapping?.resource;
  const name = resolve(raw, "name", m);
  const capacity = resolve(raw, "capacity", m);

  const resource: Resource = {
    id: asId(resolve(raw, "id", m)) ?? fallbackId,
    name: name === undefined || name === null ? "" : String(name),
  };
  if (typeof capacity === "number" && Number.isFinite(capacity)) resource.capacity = capacity;
  return resource;
}

/**
 * Returns `undefined` when either endpoint does not resolve to an id, or when `units` is not a
 * finite number greater than zero — an assignment must always satisfy those invariants.
 */
export function normalizeAssignment(
  raw: unknown,
  mapping: FieldMapping | undefined,
): Assignment | undefined {
  const m = mapping?.assignment;
  const taskId = asId(resolve(raw, "taskId", m));
  const resourceId = asId(resolve(raw, "resourceId", m));
  if (taskId === undefined || resourceId === undefined) return undefined;
  const units = resolve(raw, "units", m);
  if (typeof units !== "number" || !Number.isFinite(units) || units <= 0) return undefined;
  return { taskId, resourceId, units };
}
