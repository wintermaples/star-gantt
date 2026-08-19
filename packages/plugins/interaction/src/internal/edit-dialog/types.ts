// docs/specs/plugins/interaction.md §6.9 — the modal task-edit dialog's public shapes.
/**
 * `EditDialogField` / `EditDialogDraft` / `EditDialogRenderContext` live in the package's single
 * declaration site (`src/types.ts`, architecture.md ch. 1.4) and are re-exported from there; this
 * file re-exports them locally so the feature's own modules keep importing from `./types` as
 * before. `EditDialogFeatureConfig` is gone — the feature reads the public `EditDialogConfig`
 * (`src/config.ts`) instead, matching the other six peripheral features.
 */
export type {
  EditDialogField,
  EditDialogDraft,
  EditDialogRenderContext,
} from "../../types";
