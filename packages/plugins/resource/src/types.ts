// docs/specs/plugins/resource.md §1 / §5 / §10
/**
 * The plugin's single declaration-merging site.
 *
 * Two key spaces, both declared HERE and nowhere else: `Services` — `stargantt.resource-pool`
 * (`ResourcePoolService`, §1.1) and `stargantt.utilization` (`UtilizationService`, §1.2), provided
 * by `internal/pool/wire.ts` and `internal/utilization/wire.ts` respectively — and `Events`, the
 * one activity notification of §5 the resource-view area emits on every shown↔hidden transition.
 * This plugin defines no extension point (§4.1) and no command of its own (§5), so those two key
 * spaces stay untouched for good.
 */

import type { ResourcePoolService } from "./internal/pool/service";
import type { UtilizationService } from "./internal/utilization/service";

declare module "@stargantt/core" {
  interface Services {
    "stargantt.resource-pool": ResourcePoolService;
    "stargantt.utilization": UtilizationService;
  }
  interface Events {
    // §3.4 / §5 — the retained official-catalog event, payload unchanged.
    /**
     * Emitted when the resource-view strip crosses between shown and hidden. Visibility rides the
     * strip's height (`view/setBottomPaneHeight` on `stargantt.resource-view:panel`, a positive
     * height showing and `0` releasing), and the plugin observes the APPLIED height through the
     * contribution's `onResize`, so the event reports what the layout actually did rather than
     * what was asked for. The boot state emits nothing.
     */
    "resourceView/toggled": { open: boolean; cause: "api" };
  }
}

export {};
