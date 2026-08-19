// docs/specs/plugins/scheduling.md §5.1 / §5.3 / §5.4
/**
 * The area's `renderer/hitTest` contribution: what a point over the chart lands on — a connector
 * port, a dependency line, or neither.
 *
 * The earlier implementation built this inline inside its plugin entry. Extracted here so the two
 * hit shapes and their cursors are unit-testable without a host, and so `wire.ts` stays wiring.
 *
 * The composite the view builds consults contributions in startup order, so task-bars answers for
 * bar bodies and resize handles before this one is asked. Ports sit outside the bar and links run
 * between bars, so the two never compete for the same point.
 */
import type { HitResult, HitTester, Viewport } from "@stargantt/plugin-view";
import { LINK_CURSOR, LINK_EDIT_CURSOR, LINK_HIT_TOLERANCE, PORT_CURSOR, hitLink, hitPort } from "./geometry";
import type { RouteIndex } from "./routes";

/** What the hit tester reads. */
export interface LinkHitDeps {
  /** The routed-link geometry, memoized — the same list the line layer paints. */
  routes: RouteIndex;
  /** The current viewport, read once per hit test. */
  viewport(): Readonly<Viewport>;
  /** §5.1 — a port that is not painted is not there to be hit. */
  allowLinkCreate: boolean;
  /** §5.3 — a hidden line answers no `kind: "link"` hit. */
  showLinks: boolean;
  /** §5.4 — while link editing is on, a link hit reports the `pointer` cursor. */
  linkEditing: boolean;
}

/**
 * Builds the hit tester.
 *
 * A port hit reports `kind: "port"` with the *task* id (the end is recoverable from the hit x) and
 * the `crosshair` cursor; a line hit reports `kind: "link"` with the *link* id and either the
 * `default` cursor (links non-interactive) or `pointer` (under `linkEditing`). Both kinds are
 * declined by interaction's gesture arbiter (interaction.md §1.2/§1.3), so this area's own
 * `pointer/*` handlers see them without competing for a gesture.
 */
export function createLinkHitTester(deps: LinkHitDeps): HitTester {
  return (x: number, y: number): HitResult | undefined => {
    const vp = deps.viewport();
    const contentX = x + vp.scrollLeft;
    const contentY = y + vp.scrollTop;
    const found = deps.allowLinkCreate ? deps.routes.taskAtY(contentY) : undefined;
    if (found !== undefined) {
      const end = hitPort(found.box, contentX, contentY);
      // `HitResult.kind` is an open union so plugins can report their own shapes; the spec names
      // only "bar", "handle" and "link". A connector port is this area's own shape.
      if (end !== undefined) return { kind: "port", id: found.task.id, cursor: PORT_CURSOR };
    }
    if (!deps.showLinks) return undefined;
    const cursor = deps.linkEditing ? LINK_EDIT_CURSOR : LINK_CURSOR;
    for (const entry of deps.routes.routedLinks(vp)) {
      // Bounding prefilter: the memoized horizontal extent rejects most lines before the
      // per-segment distance test runs, keeping a resting pointer cheap on link-heavy charts.
      if (contentX < entry.minX - LINK_HIT_TOLERANCE || contentX > entry.maxX + LINK_HIT_TOLERANCE) {
        continue;
      }
      if (hitLink(entry.route, contentX, contentY)) {
        return { kind: "link", id: entry.link.id, cursor };
      }
    }
    return undefined;
  };
}
