/**
 * Standard status / priority / tags / deadline / notes / actual-date / display-ID attributes for
 * tasks, stored in each task's `meta` bag, with grid columns, bar decorations and a side-panel
 * editing section, plus duration-unit helpers and task templates.
 *
 * Every write goes through the existing `task/update` / `task/add` / `assignment/set` /
 * `assignment/remove` commands, so undo/redo integration is inherited; no new store, command or
 * event is introduced by this feature.
 */
import type { PluginContext } from "@stargantt/core";
import type {
  DataService,
  Patch,
  Resource,
  ResourceId,
  Task,
  TaskId,
} from "@stargantt/plugin-data-store";
import type { ThemeService } from "@stargantt/plugin-view";
import { createTransactionBatcher, listen } from "@stargantt/sdk";
import type { ColumnDef, TaskFieldsPatch, TreeGridMessages } from "../../types";
import { contributeUpward } from "../upward";
import type { TaskFieldsConfig } from "./types";
import { fieldsOfTask, isOverdueValues, mergeFieldValues, metaWith } from "./fields";
import { durationIn, parseDurationInput, resolveUnit } from "./duration";
import { UNIT_MS } from "./duration";
import { formatSequenceId, resolveNumbering, sequenceCache } from "./sequence";
import { MS_DAY, resolveTemplates, startOfUtcDay } from "./templates";
import { DEFAULT_COLUMNS, buildColumns, resolveColumns } from "./columns";
import { makeOverlayRenderer } from "./overlays";
import { makePanelContribution } from "./panel";
import { appendCompletionStamps } from "./auto-complete";

export type { TaskFieldsConfig } from "./types";

const PLUGIN_ID = "stargantt.tree-grid";

/** What `setupTaskFields` needs from the containing plugin. */
export interface TaskFieldsDeps {
  /** Resolved `taskFields` config nest. */
  config: TaskFieldsConfig;
  /** The resolved plugin-wide message catalog. */
  messages: TreeGridMessages;
  /** `ctx.use("stargantt.data")`, resolved by the caller. */
  data: DataService;
  /** `ctx.use("stargantt.theme")`, resolved by the caller. */
  theme: ThemeService;
  /** Contributes one grid column to `grid/columns`. */
  contributeColumn(column: ColumnDef): void;
}

/**
 * Wires the standard field columns, bar overlays, side-panel section and completion auto-record
 * into the containing plugin, using the resolved `taskFields` config nest.
 */
export function setupTaskFields(ctx: PluginContext, deps: TaskFieldsDeps): void {
  const { config, messages, data, theme } = deps;

  const unit = resolveUnit(config.durationUnit);
  const numbering = resolveNumbering(config.idNumbering);
  const templates = resolveTemplates(config.templates);
  const columnIds = config.columns === undefined ? DEFAULT_COLUMNS : resolveColumns(config.columns);
  const showStatus = config.showStatusOnBars !== false;
  const showDeadline = config.showDeadlineWarnings !== false;
  const showAvatars = config.showAssigneeAvatars !== false;
  const detailFields = config.detailFields !== false;
  const autoRecord = config.autoRecordCompletion !== false;

  /* --- sequence-ID cache ------------------------------------------------ */

  const sequence = sequenceCache(() => data.taskIds());
  ctx.own(data.tasks.subscribe(() => sequence.invalidate()));

  /* --- the internal read/write helpers ---------------------------------- */

  // docs/specs/plugins/tree-grid.md § Dependencies — the shared head-command transaction batcher;
  // keyed on per-call unique origins, never a re-entrancy flag.
  const batchAssignees = createTransactionBatcher<Patch>(ctx, `${PLUGIN_ID}/setAssignees`);

  function setFields(id: TaskId, patch: Readonly<TaskFieldsPatch>): void {
    const task = data.getTask(id);
    if (task === undefined) return;
    const merged = mergeFieldValues(fieldsOfTask(task), patch);
    const meta = metaWith(task.meta, merged);
    if (meta === undefined) ctx.dispatch("task/update", { id, after: {}, clears: ["meta"] });
    else ctx.dispatch("task/update", { id, after: { meta } });
  }

  function assigneesOf(id: TaskId): readonly Readonly<Resource>[] {
    const view = data.query();
    const assignments = view.assignmentsByTask.get(id) ?? [];
    const out: Readonly<Resource>[] = [];
    for (const a of assignments) {
      const resource = view.resources.get(a.resourceId);
      if (resource !== undefined) out.push(resource);
    }
    return out;
  }

  function displayId(id: TaskId): string | undefined {
    const task = data.getTask(id);
    if (task === undefined) return undefined;
    const custom = fieldsOfTask(task).customId;
    if (custom !== undefined) return custom;
    const position = sequence.positionOf(id);
    return position === undefined ? undefined : formatSequenceId(numbering, position);
  }

  function isOverdue(id: TaskId, now: number = Date.now()): boolean {
    return isOverdueValues(fieldsOfTask(data.getTask(id)), now);
  }

  // docs/specs/plugins/tree-grid.md § Dependencies — one call, one undoable step: the first change
  // is dispatched as a validated public head command and the rest ride the same transaction via
  // the shared batcher, so a 3-way replace undoes in one step.
  function setAssignees(id: TaskId, resourceIds: readonly ResourceId[]): void {
    if (data.getTask(id) === undefined || !Array.isArray(resourceIds)) return;
    const view = data.query();
    const desired = new Set<ResourceId>(resourceIds);
    const current = view.assignmentsByTask.get(id) ?? [];
    const removals = current.filter((a) => !desired.has(a.resourceId));
    for (const a of current) desired.delete(a.resourceId);
    // Mirror `assignment/set`'s endpoint validation: appended tail patches apply verbatim, so a
    // resource the store does not hold must be dropped here, exactly as the command would.
    const additions = [...desired].filter((rid) => view.resources.get(rid) !== undefined);
    const changes: Patch[] = [
      ...removals.map((a): Patch => ({ op: "assignment/remove", assignment: a })),
      ...additions.map(
        (rid): Patch => ({
          op: "assignment/add",
          assignment: { taskId: id, resourceId: rid, units: 1 },
        }),
      ),
    ];
    const [head, ...tail] = changes;
    if (head === undefined) return;
    batchAssignees((origin) => {
      if (head.op === "assignment/remove") {
        ctx.dispatch("assignment/remove", {
          taskId: id,
          resourceId: head.assignment.resourceId,
          origin,
        });
      } else if (head.op === "assignment/add") {
        ctx.dispatch("assignment/set", {
          taskId: id,
          resourceId: head.assignment.resourceId,
          units: 1,
          origin,
        });
      }
    }, tail);
  }

  function durationOf(id: TaskId): number | undefined {
    const task = data.getTask(id);
    return task === undefined ? undefined : durationIn(unit, task.start, task.end);
  }

  function setDuration(id: TaskId, value: number): void {
    const task = data.getTask(id);
    if (task === undefined) return;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
    ctx.dispatch("task/update", { id, after: { end: task.start + value * UNIT_MS[unit] } });
  }

  function templateNames(): readonly string[] {
    return [...templates.keys()];
  }

  function applyTemplate(id: TaskId, template: string): boolean {
    const resolved = templates.get(template);
    if (resolved === undefined || data.getTask(id) === undefined) return false;
    setFields(id, resolved.fields);
    return true;
  }

  function createFromTemplate(
    template: string,
    base?: { name?: string; parentId?: TaskId | null; start?: number },
  ): boolean {
    const resolved = templates.get(template);
    if (resolved === undefined) return false;
    const start =
      typeof base?.start === "number" && Number.isFinite(base.start)
        ? base.start
        : startOfUtcDay(Date.now());
    const task: Partial<Task> & { name: string } = {
      name: base?.name ?? resolved.name ?? messages.templateTaskName,
      parentId: base?.parentId ?? null,
      start,
      end: start + (resolved.durationMs ?? MS_DAY),
    };
    const meta = metaWith(undefined, resolved.fields);
    if (meta !== undefined) task.meta = meta;
    ctx.dispatch("task/add", { task });
    return true;
  }

  /* --- grid columns ------------------------------------------------------ */

  if (columnIds.length > 0) {
    const columns = buildColumns(columnIds, {
      messages,
      unit,
      displayIdOf: (task) => displayId(task.id) ?? "",
      assigneeTextOf: (task) => assigneesOf(task.id).map((r) => r.name).join(", "),
      now: () => Date.now(),
    });
    for (const column of columns) deps.contributeColumn(column);
  }

  /* --- bar overlays -------------------------------------------------------- */

  if (showStatus || showDeadline || showAvatars) {
    ctx.contribute(
      "taskbars/overlays",
      makeOverlayRenderer({
        showStatus,
        showDeadline,
        showAvatars,
        fieldsOf: (id) => fieldsOfTask(data.getTask(id)),
        assigneeNamesOf: (id) => assigneesOf(id).map((r) => r.name),
        themeGet: (token) => theme.get(token),
        now: () => Date.now(),
      }),
    );
  }

  /* --- side-panel section --------------------------------------------------- */

  if (detailFields) {
    contributeUpward(
      ctx,
      "sidepanel/fields",
      makePanelContribution({
        messages,
        commit: setFields,
        listen: (target, type, fn) => listen(ctx, target, type, fn as (e: never) => void),
      }),
    );
  }

  /* --- completion auto-record ---------------------------------------------- */

  if (autoRecord) {
    ctx.on("data/willApplyTransaction", (e) => {
      appendCompletionStamps(e.transaction.patches, (id) => data.getTask(id), Date.now());
    });
  }
}
