// docs/specs/plugins/interaction.md §6.4 – §6.10 — the seam the seven peripheral features are wired
// through.
/**
 * One bag every peripheral feature's `wire*` entry point takes.
 *
 * The three features the gesture arbiter dispatches to — tooltip, context menu, edit dialog —
 * install their implementation through the setters below; until they do, the arbiter drives the
 * inert defaults declared here, which is exactly the behaviour of a composition whose nest was
 * omitted.
 */
import type { PluginContext } from "@stargantt/core";
import type { InteractionMessages } from "../messages";
import type { SelectionService, SnapService } from "../types";
import type { ArbiterContextMenu, ArbiterEditDialog, ArbiterTooltip } from "./gesture/arbiter";

/** What every `wire*` entry point is handed. */
export interface PeripheralWiring {
  ctx: PluginContext;
  /** The resolved message catalog, shared by all ten features. */
  messages: InteractionMessages;
  /** The feature's own configuration nest, exactly as the host passed it. */
  config: Record<string, unknown>;
  /** The chart's selection — most of the seven read or act on it. */
  selection: SelectionService;
  /** The chart's rounding rule. */
  snap: SnapService;
  /** Installs the tooltip implementation the arbiter dispatches to. */
  setTooltip(impl: ArbiterTooltip): void;
  /** Installs the context-menu implementation the arbiter dispatches to. */
  setContextMenu(impl: ArbiterContextMenu): void;
  /** Installs the edit-dialog implementation the arbiter dispatches to. */
  setEditDialog(impl: ArbiterEditDialog): void;
  /** Reports that the menu widget closed itself, so the arbiter leaves its `context` state. */
  menuClosed(): void;
  /** Reports a fault in host-supplied code. */
  reportError(error: unknown): void;
}

/** The tooltip the arbiter drives before a real one is installed: every input is a no-op. */
export const INERT_TOOLTIP: ArbiterTooltip = {
  hover: () => {},
  press: () => {},
  suppress: () => {},
  dismiss: () => {},
};

/**
 * The context menu the arbiter drives before a real one is installed.
 *
 * `enabled()` answers `false`, which is what keeps a menu press an ordinary press — the `context`
 * state is unreachable in a composition without the feature, so the `openAt*` members' `false`
 * returns (minor-1: whether a menu actually opened) are never even consulted in that composition.
 */
export const INERT_CONTEXT_MENU: ArbiterContextMenu = {
  enabled: () => false,
  openAtHit: () => false,
  openAtBackground: () => false,
  openAtRow: () => false,
  openAtGridBackground: () => false,
  close: () => {},
};

/** The edit dialog the arbiter drives before a real one is installed: activations are counted nowhere. */
export const INERT_EDIT_DIALOG: ArbiterEditDialog = {
  press: () => {},
  reset: () => {},
};
