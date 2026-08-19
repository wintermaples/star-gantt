import { useEffect, useRef, useState } from "react";
import type { GanttInstance } from "stargantt";
import type { DemoSpec } from "../content/types";
import { SAMPLE_TASKS } from "../lib/data";
import { loadStarGantt } from "../lib/stargantt";
import { subscribeTheme } from "../lib/theme";
import { RichText } from "./RichText";

/** The nearest ancestor that scrolls, or `null` for the viewport when nothing between does. */
function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

export interface GanttPreviewProps {
  /** What to mount. Must be referentially stable — memoize it, or the chart rebuilds every render. */
  spec: DemoSpec;
  /** Small line under the chart naming what is being shown. */
  caption?: string;
  /** Overrides `spec.height`. */
  height?: number;
}

/**
 * Mounts a real StarGantt instance: the shipped bundle, the public `create()` entry, the standard
 * preset plus whatever opt-in plugins the demo asks for. There is no docs-only path into the
 * library — if a chart on this site works, the same code works in a reader's project.
 *
 * The bundle is fetched on demand (`loadStarGantt`), so a page's prose paints without waiting for
 * it. Every mount therefore begins one microtask late, which nothing on the page depends on and
 * `data-render` makes observable for anything that does.
 *
 * A demo that throws is caught and shown in place. That is deliberate: a broken example must be
 * visible as broken, on the page, rather than leaving a blank rectangle that reads as "this option
 * does nothing".
 */
export function GanttPreview({ spec, caption, height }: GanttPreviewProps): React.JSX.Element {
  const mount = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Counts completed mounts, published as `data-render` so a test can wait for *this* spec's chart
  // rather than for the pixels to stop moving. Waiting on pixels alone reads the previous chart as
  // the current one whenever a rebuild takes longer to start than the sampling interval, and that
  // misread is silent: two different options come back byte-identical and the page looks like it
  // has a control with no consequence.
  const [generation, setGeneration] = useState(0);
  // A guide page holds up to six charts, and a reader sees one of them. Nothing is built until it
  // has come within a screen of the viewport; once built it stays, because tearing a chart down on
  // scroll would throw away the scroll position, selection and expand state the reader put into it.
  const [wanted, setWanted] = useState(false);

  useEffect(() => {
    const element = mount.current;
    if (!element || wanted) return;
    if (typeof IntersectionObserver !== "function") {
      setWanted(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setWanted(true);
          observer.disconnect();
        }
      },
      // The root has to be the pane that scrolls, not the viewport. An element clipped out of an
      // intermediate scroll container has an empty visible rect whatever the viewport is doing, and
      // `rootMargin` grows the root — so against the viewport every chart below the fold stayed at
      // zero intersection forever and never mounted at all.
      { root: scrollParentOf(element), rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [wanted]);

  useEffect(() => {
    const element = mount.current;
    if (!element || !wanted) return;
    setError(null);
    let disposed = false;
    let instance: GanttInstance | undefined;
    let unsubscribe: (() => void) | undefined;

    void loadStarGantt().then(
      (StarGantt) => {
        // The effect was cleaned up while the bundle was in flight — a fast navigation, or
        // StrictMode's double invoke. Mounting now would attach a chart nothing will dispose.
        if (disposed) return;
        try {
          const plugins = [
            ...StarGantt.presetStandard(spec.preset ?? {}),
            ...(spec.plugins?.(StarGantt) ?? []),
          ];
          instance = StarGantt.create({ element, plugins });
          instance.service("stargantt.data").load([...(spec.data ?? SAMPLE_TASKS)] as never);
          // The site's theme button writes `data-theme` on `<html>`. A chart watches its own
          // element for that attribute, never its ancestors, so without this call the tokens
          // change underneath a chart that has already cached them and it repaints half in one
          // scheme and half in the other. `refresh()` is the documented way for a host to say so.
          const chart = instance;
          unsubscribe = subscribeTheme(() => chart.service("stargantt.theme").refresh());
        } catch (cause) {
          setError(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
        }
        // Bumped whether the mount succeeded or threw: "this spec has been attempted" is what a
        // waiter needs, and a demo that throws still has to end the wait rather than hang it.
        setGeneration((n) => n + 1);
      },
      (cause: unknown) => {
        if (disposed) return;
        setError(`the StarGantt bundle failed to load — ${String(cause)}`);
        setGeneration((n) => n + 1);
      },
    );

    return () => {
      disposed = true;
      unsubscribe?.();
      instance?.dispose();
    };
  }, [spec, wanted]);

  return (
    <div className="preview" data-testid="gantt-preview" data-render={generation}>
      <div ref={mount} className="preview-mount" style={{ height: height ?? spec.height ?? 300 }} />
      {caption ? (
        <div className="preview-caption">
          <RichText>{caption}</RichText>
        </div>
      ) : null}
      {error ? (
        <div className="preview-error" role="alert">
          This example failed to run — {error}
        </div>
      ) : null}
    </div>
  );
}
