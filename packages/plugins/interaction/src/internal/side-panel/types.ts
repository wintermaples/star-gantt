// docs/specs/plugins/interaction.md §6.10 — the right-hand detail pane's public shapes.
/**
 * `SidePanelFieldContribution` / `SidePanelFieldHandle` / `SidePanelRenderContext` live in the
 * package's single declaration site (`src/types.ts`, architecture.md ch. 1.4) and are re-exported
 * from there; this file re-exports them locally (plus the local `FieldKey` alias of
 * `SidePanelFieldKey`) so the feature's own modules keep importing from `./types` as before.
 * `SidePanelFeatureConfig` is gone — the feature reads the public `SidePanelConfig`
 * (`src/config.ts`) instead, matching the other six peripheral features.
 */
export type {
  SidePanelFieldContribution,
  SidePanelFieldHandle,
  SidePanelRenderContext,
  SidePanelFieldKey as FieldKey,
} from "../../types";
