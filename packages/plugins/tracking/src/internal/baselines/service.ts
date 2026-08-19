// docs/specs/plugins/tracking.md §1.1 — assembles the final `BaselinesService` from the set/
// variance/cpm pieces (the split the spec's §7 table names for this file).
import type { BaselinesService } from "../../types";
import type { BaselinesStateApi } from "./set";
import type { VarianceApi } from "./variance";
import type { CpmApi } from "./cpm";

/** Composes the 14-member `BaselinesService` (§1.1) from its three pieces. */
export function createBaselinesService(
  state: BaselinesStateApi,
  variance: VarianceApi,
  cpm: CpmApi,
): BaselinesService {
  return {
    state: state.state,
    save: state.save,
    get: state.get,
    remove: state.remove,
    setActive: state.setActive,
    snapshotOf: state.snapshotOf,
    variance: variance.variance,
    milestoneVariance: variance.milestoneVariance,
    summary: variance.summary,
    reportCSV: variance.reportCSV,
    actualOf: state.actualOf,
    setActual: state.setActual,
    criticalPath: cpm.criticalPath,
    criticalPathDelta: cpm.criticalPathDelta,
  };
}
