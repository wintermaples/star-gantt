/**
 * The `taskbars/endGutter` reduction of `stargantt.task-bars`: how much clearance is reserved
 * immediately outside a bar's start and end edges.
 *
 * The rule is a pure function over the contributions; the small holder around it exists because the
 * core caches a reduction while the contribution set is unchanged, and this reservation has to
 * re-read every `active()` once per paint pass so it flips with the feature that owns it.
 */
import type { EndGutterContribution, ResolvedEndGutter } from "../types";

/** The reservation of a chart nothing contributes to: no clearance at either end. */
export const NO_GUTTER: Readonly<ResolvedEndGutter> = { start: 0, end: 0 };

// The per-end maximum of the active contributions, the model being `renderer/insets` applied to a
// bar's ends. A contribution whose `size` is not a finite number above 0, or whose `active` is not
// a function, is ignored (the unusable-value rule applied to a contribution) rather than faulting
// the point.
/** Reduces the contributions to one chart-wide pair of reserved widths. */
export function resolveEndGutter(
  contributions: readonly EndGutterContribution[] | undefined,
): ResolvedEndGutter {
  let start = 0;
  let end = 0;
  for (const contribution of contributions ?? []) {
    if (contribution === null || typeof contribution !== "object") continue;
    const { size } = contribution;
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) continue;
    if (typeof contribution.active !== "function") continue;
    if (!contribution.active()) continue;
    const covers = contribution.end;
    if (covers === "start" || covers === "both") start = Math.max(start, size);
    if (covers === "end" || covers === "both") end = Math.max(end, size);
  }
  return { start, end };
}

// `active()` is a function-shaped contribution, so the point-owning plugin guards it and reports
// through `core/pluginError`. The barrier is latched for the same reason the paint-loop barriers
// are: the resolution runs once per frame, and an unlatched report would emit at frame rate.
/** Wraps one contribution's `active()` in a latched fault barrier. */
function guardActive(
  contribution: EndGutterContribution,
  fault: (error: unknown) => void,
): EndGutterContribution {
  if (contribution === null || typeof contribution !== "object") return contribution;
  if (typeof contribution.active !== "function") return contribution;
  let faulted = false;
  return {
    id: contribution.id,
    end: contribution.end,
    size: contribution.size,
    active: () => {
      if (faulted) return false;
      try {
        return contribution.active();
      } catch (error) {
        faulted = true;
        fault(error);
        return false;
      }
    },
  };
}

/** How the paint pass and the geometry service read the resolved reservation. */
export interface EndGutterReader {
  /** The pair every box published since the last resolution carries. */
  current(): Readonly<ResolvedEndGutter>;
  /** Re-resolves from the current contribution set. One call per paint pass. */
  refresh(): void;
}

/** The point's reduction together with the reader the rest of the plugin holds. */
export interface EndGutter extends EndGutterReader {
  /**
   * The reduction to hand to `defineExtensionPoint`. It resolves the pair and keeps the guarded
   * contribution set, so {@link EndGutterReader.refresh} can re-read `active()` afterwards without
   * the core's cached reduction standing in the way.
   */
  reduce(inputs: readonly EndGutterContribution[]): ResolvedEndGutter;
}

/** Builds the end-gutter reduction of one plugin instance. */
export function createEndGutter(fault: (error: unknown) => void): EndGutter {
  let guarded: EndGutterContribution[] = [];
  let resolved: ResolvedEndGutter = { start: 0, end: 0 };
  return {
    reduce(inputs) {
      guarded = inputs.map((contribution) => guardActive(contribution, fault));
      resolved = resolveEndGutter(guarded);
      return resolved;
    },
    current: () => resolved,
    refresh() {
      resolved = resolveEndGutter(guarded);
    },
  };
}
