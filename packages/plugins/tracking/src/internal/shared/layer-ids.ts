// docs/specs/plugins/tracking.md §3.2 — the three `renderer/layers` claims, made once at the root
// (`index.ts`, per §7's "root does all claimKey/claimOrder calls") and referenced by id/order here
// so the claiming call and each area's `ctx.contribute("renderer/layers", …)` can never drift apart.
export const BASELINES_LAYER_ID = "stargantt.tracking:baselines";
export const BASELINES_LAYER_ORDER = 50;

export const ACTUALS_LAYER_ID = "stargantt.tracking:actuals";
export const ACTUALS_LAYER_ORDER = 62;

export const PROGRESS_LINE_LAYER_ID = "stargantt.tracking:progress-line";
export const PROGRESS_LINE_LAYER_ORDER = 65;
