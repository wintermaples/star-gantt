import { useEffect, useMemo, useRef, useState } from "react";
import { LazyCodeEditor } from "../components/LazyCodeEditor";
import { GanttPreview } from "../components/GanttPreview";
import { RichParagraph, RichText } from "../components/RichText";
import { routes } from "../content/registry";
import type { AnyPlugin, DemoSpec, PluginDoc, PropertyDoc } from "../content/types";
import { pluginById, shortName } from "../generated/api";
import { oneLine } from "../lib/apiText";
import { printSpec } from "../lib/printSpec";
import { currentQuery, href } from "../lib/router";
import { useMediaQuery } from "../lib/useMediaQuery";

/**
 * A plugin's config detail page: the sticky-split layout.
 *
 * One chart instance for the whole page. Choosing a value re-applies it rather than re-mounting, so
 * a reader comparing two values keeps their scroll position and their place in the data. Scrolling
 * only decides which option is *highlighted* — applying a value is always an explicit button press,
 * because a scroll-driven side effect is invisible to a keyboard or screen-reader user and would
 * leave them with no way to drive the preview at all.
 */
export function PluginConfigPage({ doc }: { doc: PluginDoc }): React.JSX.Element {
  const api = pluginById(doc.id);
  const stacked = useMediaQuery("(max-width: 1180px)");
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const proseRef = useRef<HTMLDivElement>(null);

  const documented = useMemo(
    () => doc.properties.filter((p) => p.demo.kind === "values"),
    [doc],
  );
  const first = documented[0]?.name ?? doc.properties[0]?.name ?? "";
  const [active, setActive] = useState<string>(() => currentQuery().get("p") ?? first);

  const spec = useMemo(() => mergeSpecs(doc.demo, doc.properties, chosen), [doc, chosen]);

  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const name = hit?.target.getAttribute("data-prop");
        if (name) setActive(name);
      },
      { root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    for (const section of root.querySelectorAll<HTMLElement>("[data-prop]")) observer.observe(section);
    return () => observer.disconnect();
  }, [doc]);

  // `?p=<option>` scrolls one option's section into view. It runs on mount, and again on every
  // hash change: a search result for another option on the page this reader is already looking at
  // changes the query without changing the route, so the component is never remounted.
  useEffect(() => {
    const jump = (): void => {
      const target = currentQuery().get("p");
      if (!target) return;
      proseRef.current
        ?.querySelector(`[data-prop="${CSS.escape(target)}"]`)
        ?.scrollIntoView({ block: "start" });
    };
    jump();
    window.addEventListener("hashchange", jump);
    return () => window.removeEventListener("hashchange", jump);
  }, [doc]);

  if (!api) {
    return (
      <div className="page">
        <div className="callout err">
          <b>{doc.id}</b> is not in <code>api.json</code>. Re-run <code>node tools/extract-api.ts</code>.
        </div>
      </div>
    );
  }

  const generated = new Map(api.config.map((option) => [option.name, option]));
  const changed = Object.values(chosen).filter((index) => index !== 0).length;

  const configCard = (
    <div className="card">
      <div className="card-head">
        <span>your config so far</span>
      </div>
      <LazyCodeEditor value={printSpec(spec)} onChange={() => undefined} readOnly />
    </div>
  );

  return (
    <div className={`split${stacked ? " stacked" : ""}`}>
      <div className="split-prose" ref={proseRef}>
        <div className="crumb">
          Reference / {api.category} / <a href={href(routes.plugin(api.id))}>{shortName(api.id)}</a> / Config
        </div>
        <h1 style={{ fontSize: 22 }}>{api.configType ?? "Configuration"}</h1>
        <p className="lede">
          {api.config.length} option{api.config.length === 1 ? "" : "s"}, each with a pinned chart
          showing what it does. Pick a value and that chart re-applies it — the instance is never
          rebuilt, so its scroll position and selection survive.
        </p>
        {stacked ? <div style={{ marginBottom: 18 }}>{configCard}</div> : null}

        {/* Authored order, not declaration order: the page teaches, and the order options were
            declared in is an implementation detail. The coverage test guarantees the two sets
            match exactly, so nothing can be lost by following the author's sequence. */}
        {doc.properties.map((written) => {
          const option = generated.get(written.name) ?? {
            name: written.name,
            type: "unknown",
            optional: true,
            doc: "",
          };
          return (
            <section
              key={option.name}
              className="prop-section"
              data-prop={option.name}
              data-active={active === option.name}
              id={option.name}
            >
              <div className="badge-row" style={{ margin: "0 0 8px" }}>
                <span className="propname">{option.name}</span>
                <span className="pill type">{oneLine(option.type)}</span>
                {option.optional ? null : <span className="pill hand">required</span>}
                {active === option.name ? <span className="pill ok">● previewing</span> : null}
              </div>

              {written.prose.map((para, i) => (
                <RichParagraph key={i}>{para}</RichParagraph>
              ))}

              <details className="tsdoc">
                <summary>Reference description (from the source)</summary>
                <div>{(generated.get(option.name)?.doc ?? "").split("\n\n").map((para, i) => (
                  <RichParagraph key={i}>{para.replace(/\s+/g, " ")}</RichParagraph>
                ))}</div>
              </details>

              {written.demo.kind === "values" ? (
                <div className="seg" role="group" aria-label={`${option.name} value`}>
                  {written.demo.values.map((value, index) => (
                    <button
                      key={value.label}
                      type="button"
                      className="btn"
                      aria-pressed={(chosen[option.name] ?? 0) === index}
                      onClick={() => {
                        setChosen((prev) => ({ ...prev, [option.name]: index }));
                        setActive(option.name);
                      }}
                    >
                      {value.label}
                    </button>
                  ))}
                </div>
              ) : written.demo.kind === "none" ? (
                <div className="callout">
                  <b>No live demo. </b>
                  <RichText>{written.demo.reason}</RichText>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      <aside className="split-side">
        <div className="split-sticky">
          <div className="badge-row" style={{ margin: 0 }}>
            <strong style={{ fontSize: 12, letterSpacing: "0.04em" }}>LIVE PREVIEW</strong>
            <span className="pill ok">{active}</span>
            <span className="spacer" style={{ flex: 1 }} />
            <button type="button" className="btn" disabled={changed === 0} onClick={() => setChosen({})}>
              Reset {changed ? `(${changed})` : ""}
            </button>
          </div>
          <GanttPreview
            spec={spec}
            // 600 rather than the 300 this started at: several plugins here are panels rather than
            // canvas marks, and at 300 a dashboard's tile grid was cut off below its second row —
            // the reader compared two values of an option by looking at the half of the answer
            // that fit. The pane is its own scroll column, so the extra height costs the config
            // listing below it nothing.
            //
            // A page may ask for more, and only more: a demo's own `height` is what the page
            // itself renders at, and the pages that set one set it small (a scrollbar demo wants a
            // short chart). Clamping to [600, 800] keeps that from shrinking the pane every other
            // option on the page is compared in, while leaving room for the one panel — evm's ten
            // dashboard tiles — that genuinely needs more than 600 to be read.
            height={stacked ? 200 : Math.min(Math.max(spec.height ?? 600, 600), 800)}
            caption="one instance — values are re-applied, not re-mounted"
          />
          {stacked ? null : configCard}
        </div>
      </aside>
    </div>
  );
}

/**
 * Keeps one instance per plugin id, the last one winning.
 *
 * A page's own `demo` usually composes the plugin it documents, and each option's values compose it
 * again with that option set — the natural way to write both, and it produces two instances of one
 * id, which the host rejects outright. The chart then does not build at all, which reads on screen
 * as "this option does nothing" rather than as an error. Later wins because the value the reader
 * just picked is the more specific intent.
 */
function dedupe(plugins: readonly AnyPlugin[]): AnyPlugin[] {
  const byId = new Map<string, AnyPlugin>();
  const anonymous: AnyPlugin[] = [];
  for (const plugin of plugins) {
    const id = plugin.meta?.id;
    if (typeof id === "string") byId.set(id, plugin);
    else anonymous.push(plugin);
  }
  return [...byId.values(), ...anonymous];
}

/**
 * Combines the plugin's baseline demo with the currently chosen value of every option.
 *
 * Merged per plugin key rather than deeply: two options of the same plugin have to land in the
 * same object, and nothing in a preset config nests deeper than that. `plugins` composes by
 * concatenation so an opt-in plugin's own options can be demonstrated alongside the preset's.
 */
function mergeSpecs(
  base: DemoSpec,
  properties: readonly PropertyDoc[],
  chosen: Record<string, number>,
): DemoSpec {
  const specs: DemoSpec[] = [base];
  for (const property of properties) {
    if (property.demo.kind !== "values") continue;
    const index = chosen[property.name] ?? 0;
    // Index 0 is the plugin's own default and contributes nothing — including its prerequisite,
    // which would otherwise configure the baseline chart every other option is measured against.
    if (index === 0) continue;
    if (property.demo.prerequisite) specs.push(property.demo.prerequisite);
    const picked = property.demo.values[index];
    if (picked) specs.push(picked.demo);
  }

  const preset: Record<string, unknown> = {};
  const builders: Array<NonNullable<DemoSpec["plugins"]>> = [];
  let data: DemoSpec["data"];
  let height: number | undefined;
  for (const spec of specs) {
    for (const [plugin, options] of Object.entries(spec.preset ?? {})) {
      preset[plugin] = { ...(preset[plugin] as object | undefined), ...(options as object) };
    }
    if (spec.plugins) builders.push(spec.plugins);
    if (spec.data) data = spec.data;
    if (spec.height) height = spec.height;
  }

  return {
    preset: preset as NonNullable<DemoSpec["preset"]>,
    ...(builders.length > 0
      ? { plugins: (sg: Parameters<NonNullable<DemoSpec["plugins"]>>[0]) => dedupe(builders.flatMap((build) => build(sg))) }
      : {}),
    ...(data ? { data } : {}),
    ...(height ? { height } : {}),
  };
}
