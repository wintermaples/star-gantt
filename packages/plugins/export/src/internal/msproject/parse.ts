// docs/specs/plugins/export.md §1.7 — MSPDI (MS Project XML) parsing: tasks with WBS/outline
// tree reconstruction, predecessor links, resources, assignments and per-task baselines. Hostless
// and pure — no store, no DOM.
import type { Assignment, Link, Resource, Task, TaskId } from "@stargantt/plugin-data-store";
import type { MsProjectBaseline, MsProjectDocument, MsProjectIssue } from "../../types";
import { childText, childrenNamed, parseXmlDocument } from "./xml";
import type { XmlElement } from "./xml";

/** Tenths of a minute — the unit of MSPDI's `LinkLag` — in milliseconds. */
export const LINK_LAG_MS = 6000;

/** MSPDI `PredecessorLink/Type` code → link type (MS Project's encoding). */
const LINK_TYPE_BY_CODE: Record<string, Link["type"]> = { "0": "FF", "1": "FS", "2": "SF", "3": "SS" };

/**
 * Parses an MSPDI date-time. Zone-less `YYYY-MM-DDTHH:MM:SS` is read as UTC (the store's
 * UTC-fixed convention); a trailing `Z` or fractional seconds is accepted. An explicit zone
 * offset (`+05:00` etc.) does not match this pattern at all, so it is rejected rather than
 * silently misread (§1.7). Returns `undefined` for anything unparsable.
 */
export function parseMspDate(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?)?$/.exec(text.trim());
  if (m === null) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = h === undefined ? 0 : Number(h);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = s === undefined ? 0 : Number(s);
  // `Date.UTC` maps a two-digit year (0-99) into 1900-1999, silently mangling any real year that
  // small; MSPDI years are always four-digit, so reject anything below the four-digit floor.
  if (year < 1000) return undefined;
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const value = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(value) ? value : undefined;
}

/** Days in `month` (1-12) of `year`, accounting for leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function finitePositive(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

interface ParsedTaskExtras {
  outlineCode: string | undefined;
  outlineLevel: number | undefined;
  element: XmlElement;
}

function emptyDocument(): MsProjectDocument {
  return { tasks: [], links: [], resources: [], assignments: [], baselines: [], issues: [] };
}

/** Whether a WBS/OutlineNumber code is dotted-numeric (`"1"`, `"2.4.1"`, …). */
function isDottedCode(code: string): boolean {
  return /^\d+(\.\d+)*$/.test(code);
}

/**
 * Rebuilds `parentId` for the parsed tasks, in document order: a dotted outline code names its
 * parent by the code minus its last segment; otherwise the outline level places the task under
 * the most recent task one level up (§1.7). Mutates the tasks in place; returns the issues raised.
 */
export function rebuildHierarchy(tasks: Task[], extras: ParsedTaskExtras[]): MsProjectIssue[] {
  const issues: MsProjectIssue[] = [];
  const byCode = new Map<string, TaskId>();
  // levelStack[level - 1] = id of the most recent task at that outline level.
  const levelStack: TaskId[] = [];
  const levelOf = new Map<TaskId, number>();

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    const extra = extras[i];
    if (task === undefined || extra === undefined) continue;
    const code = extra.outlineCode;
    let parent: TaskId | null = null;
    let level: number | undefined = extra.outlineLevel;

    if (code !== undefined) {
      byCode.set(code, task.id);
      const dot = code.lastIndexOf(".");
      if (dot < 0) {
        parent = null;
        level ??= 1;
      } else {
        const parentCode = code.slice(0, dot);
        const found = byCode.get(parentCode);
        if (found !== undefined) {
          parent = found;
          level ??= code.split(".").length;
        } else {
          issues.push({ code: "unknown-parent", taskId: task.id, wbs: code });
          parent = parentFromLevel(level, levelStack);
        }
      }
    } else {
      parent = parentFromLevel(level, levelStack);
    }

    task.parentId = parent;
    const effectiveLevel =
      level !== undefined && Number.isFinite(level) && level >= 1
        ? Math.floor(level)
        : parent === null
          ? 1
          : (levelOf.get(parent) ?? 0) + 1;
    levelOf.set(task.id, effectiveLevel);
    levelStack.length = effectiveLevel;
    levelStack[effectiveLevel - 1] = task.id;
  }
  return issues;
}

function parentFromLevel(level: number | undefined, levelStack: readonly TaskId[]): TaskId | null {
  if (level === undefined || !Number.isFinite(level) || level <= 1) return null;
  return levelStack[Math.floor(level) - 2] ?? null;
}

/** The root `<Project>` element, or `undefined` after recording why the text is unusable. */
function readProjectRoot(text: string, issues: MsProjectIssue[]): XmlElement | undefined {
  if (typeof text !== "string" || text.trim() === "") {
    issues.push({ code: "invalid-xml", reason: "not a non-empty string" });
    return undefined;
  }
  const rootElement = parseXmlDocument(text);
  if (rootElement === undefined) {
    issues.push({ code: "invalid-xml", reason: "malformed XML" });
    return undefined;
  }
  if (rootElement.name !== "Project") {
    issues.push({ code: "invalid-xml", reason: `root element is <${rootElement.name}>, expected <Project>` });
    return undefined;
  }
  return rootElement;
}

/** The direct children of `root`'s `<name>` section, or none when the section is absent. */
function sectionChildren(root: XmlElement, section: string, child: string): XmlElement[] {
  const element = root.children.find((c) => c.name === section);
  return element === undefined ? [] : childrenNamed(element, child);
}

/** A dotted-numeric hierarchy code, or `undefined` when the text is absent or not one. */
function hierarchyCode(code: string | undefined): string | undefined {
  return code !== undefined && isDottedCode(code) ? code : undefined;
}

/** The hierarchy hints of one `<Task>`: its outline code and level (§1.7's mapping table). */
function readOutlineHints(el: XmlElement): Omit<ParsedTaskExtras, "element"> {
  const levelText = childText(el, "OutlineLevel");
  const level = levelText === undefined ? undefined : Number(levelText);
  return {
    // Only dotted-numeric codes qualify as hierarchy codes; anything else (e.g. "A.1") falls
    // through to the OutlineLevel stack.
    outlineCode: hierarchyCode(childText(el, "OutlineNumber")) ?? hierarchyCode(childText(el, "WBS")),
    outlineLevel: level !== undefined && Number.isFinite(level) ? level : undefined,
  };
}

/**
 * Reads one `<Task>` element into a task, recording any issue that made it unusable. Registers
 * accepted UIDs in `seen`; returns `undefined` for skipped or rejected elements.
 */
function readTask(
  el: XmlElement,
  seen: Set<string>,
  issues: MsProjectIssue[],
): { task: Task; extra: ParsedTaskExtras } | undefined {
  const uid = childText(el, "UID");
  if (childText(el, "IsNull") === "1") return undefined;
  if (uid === undefined) {
    issues.push({ code: "invalid-task", uid: "", reason: "missing UID" });
    return undefined;
  }
  if (uid === "0") return undefined; // MS Project's hidden project-summary task.
  if (seen.has(uid)) {
    issues.push({ code: "invalid-task", uid, reason: "duplicate UID" });
    return undefined;
  }
  const startText = childText(el, "Start");
  const finishText = childText(el, "Finish");
  const start = parseMspDate(startText);
  const finish = parseMspDate(finishText);
  if (start === undefined) {
    issues.push({ code: "bad-date", field: "start", value: startText ?? "", uid });
    return undefined;
  }
  if (finish === undefined) {
    issues.push({ code: "bad-date", field: "end", value: finishText ?? "", uid });
    return undefined;
  }
  seen.add(uid);

  const task: Task = {
    id: uid,
    parentId: null,
    name: childText(el, "Name") ?? `Task ${uid}`,
    start,
    // §1.7 — `end < start` clamps to `end = start`; values otherwise map verbatim (no
    // exclusive-end adjustment).
    end: Math.max(start, finish),
  };
  const percentText = childText(el, "PercentComplete");
  const percent = percentText === undefined ? Number.NaN : Number(percentText);
  if (Number.isFinite(percent)) task.progress = Math.min(1, Math.max(0, percent / 100));
  if (childText(el, "Summary") === "1") task.type = "summary";
  else if (childText(el, "Milestone") === "1") task.type = "milestone";

  return { task, extra: { ...readOutlineHints(el), element: el } };
}

/** Adds one task's `<Baseline>` snapshots to the per-number groups (§1.7). */
function collectBaselines(el: XmlElement, task: Task, byNumber: Map<number, MsProjectBaseline>): void {
  for (const bl of childrenNamed(el, "Baseline")) {
    const numberText = childText(bl, "Number");
    const number = numberText === undefined ? 0 : Number(numberText);
    if (!Number.isFinite(number) || number < 0 || number > 10) continue;
    const blStart = parseMspDate(childText(bl, "Start"));
    const blEnd = parseMspDate(childText(bl, "Finish"));
    if (blStart === undefined || blEnd === undefined) continue;
    let group = byNumber.get(number);
    if (group === undefined) {
      group = { number, name: number === 0 ? "Baseline" : `Baseline ${number}`, tasks: [] };
      byNumber.set(number, group);
    }
    const snapshot: MsProjectBaseline["tasks"][number] = {
      id: task.id,
      start: blStart,
      end: Math.max(blStart, blEnd),
    };
    if (task.type !== undefined) snapshot.type = task.type;
    group.tasks.push(snapshot);
  }
}

/** Fills `doc.tasks`/`doc.baselines` from the `<Tasks>` section; returns the accepted UIDs. */
function parseTasksSection(
  root: XmlElement,
  doc: MsProjectDocument,
  extras: ParsedTaskExtras[],
): Set<string> {
  const seen = new Set<string>();
  const baselinesByNumber = new Map<number, MsProjectBaseline>();
  for (const el of sectionChildren(root, "Tasks", "Task")) {
    const parsed = readTask(el, seen, doc.issues);
    if (parsed === undefined) continue;
    doc.tasks.push(parsed.task);
    extras.push(parsed.extra);
    collectBaselines(el, parsed.task, baselinesByNumber);
  }
  doc.issues.push(...rebuildHierarchy(doc.tasks, extras));
  doc.baselines = [...baselinesByNumber.values()].sort((a, b) => a.number - b.number);
  return seen;
}

/** Fills `doc.links` from every task's `<PredecessorLink>` children (§1.7). */
function parseLinksSection(
  doc: MsProjectDocument,
  extras: readonly ParsedTaskExtras[],
  seen: ReadonlySet<string>,
): void {
  let linkSeq = 0;
  for (let i = 0; i < doc.tasks.length; i += 1) {
    const successor = doc.tasks[i];
    const extra = extras[i];
    if (successor === undefined || extra === undefined) continue;
    for (const pl of childrenNamed(extra.element, "PredecessorLink")) {
      const predecessorUid = childText(pl, "PredecessorUID");
      if (predecessorUid === undefined || !seen.has(predecessorUid)) {
        doc.issues.push({
          code: "unknown-link-end",
          predecessorUid: predecessorUid ?? "",
          successorUid: String(successor.id),
        });
        continue;
      }
      linkSeq += 1;
      const link: Link = {
        id: `mspl-${linkSeq}`,
        sourceId: predecessorUid,
        targetId: successor.id,
        type: LINK_TYPE_BY_CODE[childText(pl, "Type") ?? "1"] ?? "FS",
      };
      const lag = Number(childText(pl, "LinkLag") ?? "");
      if (Number.isFinite(lag) && lag !== 0) link.lag = lag * LINK_LAG_MS;
      doc.links.push(link);
    }
  }
}

/** Fills `doc.resources` from the `<Resources>` section; returns the accepted resource UIDs. */
function parseResourcesSection(root: XmlElement, doc: MsProjectDocument): Set<string> {
  const resourceIds = new Set<string>();
  for (const el of sectionChildren(root, "Resources", "Resource")) {
    const uid = childText(el, "UID");
    const name = childText(el, "Name");
    if (uid === undefined || uid === "0" || name === undefined || resourceIds.has(uid)) continue;
    resourceIds.add(uid);
    const resource: Resource = { id: uid, name };
    const capacity = finitePositive(childText(el, "MaxUnits"));
    if (capacity !== undefined) resource.capacity = capacity;
    doc.resources.push(resource);
  }
  return resourceIds;
}

/** Fills `doc.assignments` from the `<Assignments>` section, keeping only resolvable ends. */
function parseAssignmentsSection(
  root: XmlElement,
  doc: MsProjectDocument,
  seen: ReadonlySet<string>,
  resourceIds: ReadonlySet<string>,
): void {
  for (const el of sectionChildren(root, "Assignments", "Assignment")) {
    const taskUid = childText(el, "TaskUID");
    const resourceUid = childText(el, "ResourceUID");
    if (taskUid === undefined || resourceUid === undefined) continue;
    if (!seen.has(taskUid) || !resourceIds.has(resourceUid)) continue;
    const assignment: Assignment = {
      taskId: taskUid,
      resourceId: resourceUid,
      units: finitePositive(childText(el, "Units")) ?? 1,
    };
    doc.assignments.push(assignment);
  }
}

/** Parses one MSPDI XML text into a document (§1.7). Tolerant; never throws. */
export function parseMsProjectXml(text: string): MsProjectDocument {
  const doc = emptyDocument();
  const rootElement = readProjectRoot(text, doc.issues);
  if (rootElement === undefined) return doc;

  const extras: ParsedTaskExtras[] = [];
  const seen = parseTasksSection(rootElement, doc, extras);
  parseLinksSection(doc, extras, seen);
  const resourceIds = parseResourcesSection(rootElement, doc);
  parseAssignmentsSection(rootElement, doc, seen, resourceIds);
  return doc;
}
