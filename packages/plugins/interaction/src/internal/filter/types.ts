// docs/specs/plugins/interaction.md §2.3 / §6.8 — the filter feature's own public types.
/**
 * `FilterCriteria` / `FilterView` / `FilterFieldDef` / `FilterState` / `FilterService` (and the
 * `"stargantt.filter": FilterService` service-key entry) live in the package's single declaration
 * site (`src/types.ts`, architecture.md ch. 1.4); this file re-exports them locally so this
 * feature's own modules keep importing from `./types` as before.
 */
export type {
  FilterCriteria,
  FilterView,
  FilterFieldDef,
  FilterState,
  FilterService,
} from "../../types";
