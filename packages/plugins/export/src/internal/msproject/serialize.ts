// docs/specs/plugins/export.md §1.7 (Export) — MSPDI (MS Project XML) serialization of a store
// view, optionally embedding baselines. Hostless and pure — reads a data view, builds a string.
import type { Link, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import { LINK_LAG_MS } from "./parse";
import { escapeXml } from "./xml";

/** Link type → MSPDI `PredecessorLink/Type` code (§1.7's map inverted). */
const CODE_BY_LINK_TYPE: Record<Link["type"], string> = { FF: "0", FS: "1", SF: "2", SS: "3" };

/** What the serializer needs of one baseline: the per-task snapshots (in list order). */
export interface SerializableBaseline {
  tasks: ReadonlyMap<TaskId, { readonly start: number; readonly end: number }>;
}

/**
 * Formats an epoch-ms instant as MSPDI's zone-less UTC `YYYY-MM-DDTHH:MM:SS`, or `undefined` when
 * `ms` is not finite or falls outside `Date`'s representable range (skip emitting the date element
 * entirely rather than throwing or writing garbage).
 */
export function formatMspDate(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 19);
}

/** Depth-first tree order over the view, with the dotted outline number of each task. */
function walkTree(view: ReadonlyDataView): { task: Readonly<Task>; outline: string }[] {
  const out: { task: Readonly<Task>; outline: string }[] = [];
  const visit = (parent: TaskId | null, prefix: string): void => {
    const ids = view.children.get(parent) ?? [];
    let ordinal = 0;
    for (const id of ids) {
      const task = view.byId.get(id);
      if (task === undefined) continue;
      ordinal += 1;
      const outline = prefix === "" ? String(ordinal) : `${prefix}.${ordinal}`;
      out.push({ task, outline });
      visit(id, outline);
    }
  };
  visit(null, "");
  return out;
}

/** The task's own fields, without its links or baselines. */
function writeTaskFields(lines: string[], task: Readonly<Task>, outline: string, uid: number): void {
  lines.push(`      <UID>${uid}</UID>`);
  lines.push(`      <ID>${uid}</ID>`);
  lines.push(`      <Name>${escapeXml(task.name)}</Name>`);
  lines.push(`      <OutlineNumber>${outline}</OutlineNumber>`);
  lines.push(`      <WBS>${outline}</WBS>`);
  lines.push(`      <OutlineLevel>${outline.split(".").length}</OutlineLevel>`);
  const start = formatMspDate(task.start);
  const finish = formatMspDate(task.end);
  if (start !== undefined) lines.push(`      <Start>${start}</Start>`);
  if (finish !== undefined) lines.push(`      <Finish>${finish}</Finish>`);
  lines.push(`      <Milestone>${task.type === "milestone" ? 1 : 0}</Milestone>`);
  lines.push(`      <Summary>${task.type === "summary" ? 1 : 0}</Summary>`);
  if (typeof task.progress === "number" && Number.isFinite(task.progress)) {
    const percent = Math.round(Math.min(1, Math.max(0, task.progress)) * 100);
    lines.push(`      <PercentComplete>${percent}</PercentComplete>`);
  }
}

/** The `<PredecessorLink>` children for the task's incoming links whose source is in the export. */
function writePredecessorLinks(
  lines: string[],
  view: ReadonlyDataView,
  taskId: TaskId,
  uidByTask: ReadonlyMap<TaskId, number>,
): void {
  for (const link of view.linksByTask.get(taskId)?.in ?? []) {
    const sourceUid = uidByTask.get(link.sourceId);
    if (sourceUid === undefined) continue;
    lines.push("      <PredecessorLink>");
    lines.push(`        <PredecessorUID>${sourceUid}</PredecessorUID>`);
    lines.push(`        <Type>${CODE_BY_LINK_TYPE[link.type] ?? "1"}</Type>`);
    if (typeof link.lag === "number" && Number.isFinite(link.lag) && link.lag !== 0) {
      lines.push(`        <LinkLag>${Math.round(link.lag / LINK_LAG_MS)}</LinkLag>`);
      lines.push("        <LagFormat>7</LagFormat>");
    }
    lines.push("      </PredecessorLink>");
  }
}

/** The task's `<Baseline>` children — MS Project caps them at 11 generations (numbers 0..10). */
function writeTaskBaselines(
  lines: string[],
  baselines: readonly SerializableBaseline[],
  taskId: TaskId,
): void {
  baselines.slice(0, 11).forEach((baseline, number) => {
    const snapshot = baseline.tasks.get(taskId);
    if (snapshot === undefined) return;
    const start = formatMspDate(snapshot.start);
    const finish = formatMspDate(snapshot.end);
    lines.push("      <Baseline>");
    lines.push(`        <Number>${number}</Number>`);
    if (start !== undefined) lines.push(`        <Start>${start}</Start>`);
    if (finish !== undefined) lines.push(`        <Finish>${finish}</Finish>`);
    lines.push("      </Baseline>");
  });
}

/** The `<Resources>` section; returns the resource id → UID map the assignments need. */
function writeResources(lines: string[], view: ReadonlyDataView): Map<string | number, number> {
  const resourceUids = new Map<string | number, number>();
  lines.push("  <Resources>");
  let resourceSeq = 0;
  for (const resource of view.resources.values()) {
    resourceSeq += 1;
    resourceUids.set(resource.id, resourceSeq);
    lines.push("    <Resource>");
    lines.push(`      <UID>${resourceSeq}</UID>`);
    lines.push(`      <ID>${resourceSeq}</ID>`);
    lines.push(`      <Name>${escapeXml(resource.name)}</Name>`);
    if (
      typeof resource.capacity === "number" &&
      Number.isFinite(resource.capacity) &&
      resource.capacity > 0
    ) {
      lines.push(`      <MaxUnits>${resource.capacity}</MaxUnits>`);
    }
    lines.push("    </Resource>");
  }
  lines.push("  </Resources>");
  return resourceUids;
}

/** The `<Assignments>` section, keeping only assignments whose task and resource were written. */
function writeAssignments(
  lines: string[],
  view: ReadonlyDataView,
  uidByTask: ReadonlyMap<TaskId, number>,
  resourceUids: ReadonlyMap<string | number, number>,
): void {
  lines.push("  <Assignments>");
  let assignmentSeq = 0;
  for (const perTask of view.assignmentsByTask.values()) {
    for (const assignment of perTask) {
      const taskUid = uidByTask.get(assignment.taskId);
      const resourceUid = resourceUids.get(assignment.resourceId);
      if (taskUid === undefined || resourceUid === undefined) continue;
      assignmentSeq += 1;
      lines.push("    <Assignment>");
      lines.push(`      <UID>${assignmentSeq}</UID>`);
      lines.push(`      <TaskUID>${taskUid}</TaskUID>`);
      lines.push(`      <ResourceUID>${resourceUid}</ResourceUID>`);
      lines.push(`      <Units>${assignment.units}</Units>`);
      lines.push("    </Assignment>");
    }
  }
  lines.push("  </Assignments>");
}

/** Serializes the view (and baselines) as an MSPDI `<Project>` document (§1.7). */
export function serializeMsProjectXml(
  view: ReadonlyDataView,
  baselines: readonly SerializableBaseline[],
  projectName?: string,
): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'];
  lines.push('<Project xmlns="http://schemas.microsoft.com/project">');
  if (typeof projectName === "string" && projectName.trim() !== "") {
    lines.push(`  <Name>${escapeXml(projectName)}</Name>`);
    lines.push(`  <Title>${escapeXml(projectName)}</Title>`);
  }

  const ordered = walkTree(view);
  const uidByTask = new Map<TaskId, number>();
  ordered.forEach(({ task }, index) => uidByTask.set(task.id, index + 1));

  lines.push("  <Tasks>");
  for (const { task, outline } of ordered) {
    lines.push("    <Task>");
    writeTaskFields(lines, task, outline, uidByTask.get(task.id) ?? 0);
    writePredecessorLinks(lines, view, task.id, uidByTask);
    writeTaskBaselines(lines, baselines, task.id);
    lines.push("    </Task>");
  }
  lines.push("  </Tasks>");

  const resourceUids = writeResources(lines, view);
  writeAssignments(lines, view, uidByTask, resourceUids);
  lines.push("</Project>");
  return lines.join("\n");
}
