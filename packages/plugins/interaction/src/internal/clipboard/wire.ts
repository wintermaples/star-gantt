// docs/specs/plugins/interaction.md §6.7 — the three clipboard commands and the native copy/paste wiring
/**
 * Wiring entry point of the `clipboard` feature.
 *
 * There is no `ClipboardService` (interaction.md §2.4): "Clipboard operations are the
 * `clipboard/*` commands" — nothing else is published, so this module registers three commands,
 * contributes the duplicate chords, and wires the native `copy`/`paste` events; it holds its own
 * clipboard state in a closure.
 */
import { isEditableTarget, listen } from "@stargantt/sdk";
import type { Patch, TaskId } from "@stargantt/plugin-data-store";
import type {} from "@stargantt/plugin-tree-grid";
import { contributeKeyBinding, focusChannel } from "../upward";
import type { PeripheralWiring } from "../peripheral";
import type { ClipboardPasteOptions } from "../../types";
import { orderIds, siblingTarget, walkTargets } from "./targets";
import type { RowOrder } from "./targets";
import { capture, payloadRows, planCellPaste, planStructuredPaste } from "./transfer";
import type { ClipboardPayload, PastePlan, PasteTarget } from "./transfer";
import { parseRow, resolveColumns, serializeRows, splitTsv } from "./tsv";
import type { ClipboardColumnId } from "./tsv";

/** The resolved clipboard options (§6.7): every member present, every value usable. */
export interface ResolvedClipboardConfig {
  fields: readonly ClipboardColumnId[];
  systemClipboard: boolean;
}

/** Resolves the feature's own nest, exactly as `PeripheralWiring.config` hands it over. */
export function resolveClipboardConfig(raw: Record<string, unknown>): ResolvedClipboardConfig {
  return {
    fields: resolveColumns(raw["fields"]),
    // Anything but the literal `false` keeps the default `true` (§6 rule 3 convention).
    systemClipboard: raw["systemClipboard"] !== false,
  };
}

// §4 — normalizes line endings (CRLF/CR to LF) and strips per-line trailing whitespace
// before the own-clipboard fingerprint comparison, so an OS/app round-trip of the system clipboard
// (which commonly rewrites line endings or trims trailing blanks) does not silently downgrade a
// structured paste to a cell paste.
function fingerprint(text: string): string {
  return text
    .replace(/\r\n|\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

/** Wires the clipboard feature into the composition. */
export function wireClipboard(deps: PeripheralWiring): void {
  const { ctx, messages } = deps;
  const config = resolveClipboardConfig(deps.config);

  const data = ctx.use("stargantt.data");
  const rows: RowOrder = ctx.use("stargantt.rows");
  const focus = focusChannel(ctx);

  /* --- the held clipboard: structured payload + its cell-text fingerprint --- */
  let held: { payload: ClipboardPayload; text: string } | undefined;

  /* --- single-transaction batching over the appendable-handler path (§4) --- */
  // The pending list is a payload channel for this module's own synchronous dispatch below, not a
  // re-entrancy flag: a transaction raised by anyone else finds it `null`.
  let pending: Patch[] | null = null;
  // Runs after `src/index.ts`'s own `snap.pushSuccessors` handler on the same event (registration
  // order — `wireClipboard` is one of the peripheral features wired after the core snap/selection
  // setup).
  ctx.on("data/willApplyTransaction", (e) => {
    if (pending !== null) {
      e.transaction.patches.push(...pending);
      pending = null;
    }
  });

  /** Runs one plan as exactly one history entry. */
  function runPlan(plan: PastePlan, announce: (count: number) => string): void {
    pending = plan.rest;
    try {
      if (plan.first.command === "task/add") {
        ctx.dispatch("task/add", { task: plan.first.task, index: plan.first.index });
      } else {
        ctx.dispatch("task/update", { id: plan.first.id, after: plan.first.after });
      }
    } finally {
      pending = null;
    }
    if (plan.newTopIds.length > 0) {
      deps.selection.select(plan.newTopIds);
      // Post-paste focus move: the keyboard focus follows the pasted/duplicated selection so a
      // keyboard user's next chord acts on what they just created, not on whatever the focus was
      // on before the paste.
      const first = plan.newTopIds[0];
      if (first !== undefined) focus()?.focus(first);
    }
    focus()?.announce(announce(plan.count));
  }

  /** The default copy set: the selection in visible-row order. */
  function selectedIds(): TaskId[] {
    return orderIds([...deps.selection.state.get().taskIds], rows);
  }

  /** The anchor row: the focused task, else the first selected in row order. */
  function anchorId(): TaskId | undefined {
    const focused = focus()?.state.get().focused;
    if (focused !== undefined && data.getTask(focused) !== undefined) return focused;
    return selectedIds().find((id) => data.getTask(id) !== undefined);
  }

  function doCopy(ids?: readonly TaskId[]): { payload: ClipboardPayload; text: string } | undefined {
    const source = ids ?? selectedIds();
    const payload = capture(orderIds(source, rows), data.query());
    if (payload === undefined) return undefined;
    const text = serializeRows(payloadRows(payload), config.fields);
    return { payload, text };
  }

  const copy = (ids?: readonly TaskId[]): string | undefined => {
    const captured = doCopy(ids);
    if (captured === undefined) return undefined;
    held = captured;
    if (config.systemClipboard) {
      // Best-effort mirror to the system clipboard; a denied or missing API changes nothing.
      try {
        void ctx.root.ownerDocument.defaultView?.navigator?.clipboard
          ?.writeText(captured.text)
          .catch(() => undefined);
      } catch {
        /* fire-and-forget */
      }
    }
    focus()?.announce(messages.copied(captured.payload.tasks.length));
    return captured.text;
  };

  /** Resolves where a structured paste inserts. */
  function resolveTarget(options: ClipboardPasteOptions): PasteTarget {
    const view = data.query();
    if (Object.prototype.hasOwnProperty.call(options, "parentId")) {
      const parentId = options.parentId ?? null;
      const siblings = view.children.get(parentId) ?? [];
      const index = Math.min(Math.max(options.index ?? siblings.length, 0), siblings.length);
      // A parent that is not in the store degrades to the no-anchor root append.
      if (parentId !== null && view.byId.get(parentId) === undefined) {
        return siblingTarget(view, undefined);
      }
      return { parentId, index };
    }
    const target = siblingTarget(view, anchorId());
    if (options.index !== undefined) target.index = options.index;
    return target;
  }

  function pasteStructured(options: ClipboardPasteOptions, announce: (count: number) => string): number {
    if (held === undefined) return 0;
    const plan = planStructuredPaste(held.payload, data.query(), resolveTarget(options));
    if (plan === undefined) return 0;
    runPlan(plan, announce);
    return plan.count;
  }

  function pasteCells(text: string): void {
    // Row index binds a text row to its target, so interior blank rows must keep their position
    // (they are no-ops on existing targets and never become created tasks — see planCellPaste).
    // Only trailing field-less rows are trimmed, so a blank tail cannot stretch the target walk.
    const parsed = splitTsv(text).map((cells) => parseRow(cells, config.fields));
    while (parsed.length > 0) {
      const last = parsed[parsed.length - 1];
      if (last !== undefined && Object.keys(last).length > 0) break;
      parsed.pop();
    }
    if (parsed.length === 0) return;
    const view = data.query();
    const targets = walkTargets(view, anchorId(), parsed.length, rows, () => data.taskIds());
    const plan = planCellPaste(parsed, targets, view);
    if (plan === undefined) return;
    runPlan(plan, messages.pasted);
  }

  const paste = (options: ClipboardPasteOptions = {}): void => {
    const usable = typeof options === "object" && options !== null ? options : {};
    const text = typeof usable.text === "string" ? usable.text : undefined;
    // Text whose fingerprint (line endings and per-line trailing whitespace normalized away)
    // matches the held clipboard's cell text is this chart's own copy coming back through the
    // system clipboard, even after an OS/app round-trip that rewrote CRLF/CR to LF or trimmed
    // trailing blanks: paste it structurally instead of downgrading to a cell paste.
    if (text !== undefined && (held === undefined || fingerprint(text) !== fingerprint(held.text))) {
      if (text !== "") pasteCells(text);
      return;
    }
    void pasteStructured(usable, messages.pasted);
  };

  const duplicate = (ids?: readonly TaskId[]): void => {
    // Copy and paste in place without overwriting the held clipboard.
    const captured = doCopy(ids);
    if (captured === undefined) return;
    const view = data.query();
    const lastRoot = captured.payload.rootIds[captured.payload.rootIds.length - 1];
    const plan = planStructuredPaste(captured.payload, view, siblingTarget(view, lastRoot));
    if (plan === undefined) return;
    runPlan(plan, messages.duplicated);
  };

  /* --- commands (§4) --- */
  ctx.registerCommand("clipboard/copy", () => void copy());
  ctx.registerCommand("clipboard/paste", (payload) => paste(payload));
  ctx.registerCommand("clipboard/duplicate", () => duplicate());

  /* --- the duplicate chords (§5); buffered and inert without the a11y plugin --- */
  for (const key of ["Ctrl+D", "Meta+D"]) {
    contributeKeyBinding(ctx, {
      key,
      when: () => selectedIds().length > 0,
      run: () => duplicate(),
    });
  }

  /* --- the native clipboard events (default on) --- */
  // `isEditableTarget` (`@stargantt/sdk`) is a superset of the narrower per-plugin guards each
  // predecessor plugin hand-rolled — one shared guard instead of several narrower ones, a
  // deliberate SDK-consolidation choice (see `src/index.ts`'s keydown listener for the same note).
  if (config.systemClipboard) {
    listen(ctx, ctx.root, "copy", (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const captured = doCopy();
      if (captured === undefined) return;
      held = captured;
      e.clipboardData?.setData("text/plain", captured.text);
      e.preventDefault();
      focus()?.announce(messages.copied(captured.payload.tasks.length));
    });
    listen(ctx, ctx.root, "paste", (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text === "") return;
      e.preventDefault();
      paste({ text });
    });
  }
}
