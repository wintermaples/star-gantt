import { useMemo } from "react";
import { GanttPreview } from "../components/GanttPreview";
import { StaticCode } from "../components/StaticCode";
import { CORE, GUIDES, isDocumented, routes } from "../content/registry";
import type { DemoSpec } from "../content/types";
import { CATEGORY_ORDER, PLUGINS, pluginsByCategory, shortName } from "../generated/api";
import { href } from "../lib/router";

/**
 * The landing page — the one page on this site written entirely by hand, with no generated tables
 * and no per-option demo. It answers "what is this and should I use it", which no extraction from
 * the sources can answer.
 */
export function Home(): React.JSX.Element {
  const spec = useMemo<DemoSpec>(() => ({ preset: { treeGrid: { paneWidth: 220 } }, height: 320 }), []);

  return (
    <>
      <section className="hero">
        <h1>StarGantt</h1>
        <p>
          A gantt chart library with no runtime dependencies, built so that every feature — even
          drawing the bars — is a plugin you can replace. One HTML file and one script tag is a
          complete installation.
        </p>
        <div className="badge-row" style={{ marginTop: 14 }}>
          <span className="pill ok">zero runtime dependencies</span>
          <span className="pill type">IIFE / UMD + ESM</span>
          <span className="pill type">WCAG 2.2 AA</span>
        </div>
      </section>

      <div className="page narrow">
        <p>
          The chart below is the library running on this page. It is not a screenshot: drag a bar,
          drag its edge to resize, press <code>Tab</code> to walk the rows with the keyboard.
        </p>
        <GanttPreview spec={spec} caption="presetStandard() — everything a default chart has" />
        <p>
          <a href={href(routes.guide("what-the-standard-preset-loads"))}>
            What the standard preset loads
          </a>{" "}
          — the nine plugins behind that chart, in composition order, and the option key for
          each one.
        </p>

        <hr className="section-rule" />

        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Install</h2>
        <p>
          The bundle carries the kernel, every official plugin and the stylesheet in one file.
          Nothing is fetched at runtime.
        </p>
        <StaticCode
          language="html"
          source={`<div id="chart" style="height: 480px"></div>
<script src="stargantt.iife.js"></script>
<script>
  const gantt = StarGantt.create({
    element: document.getElementById("chart"),
    plugins: StarGantt.presetStandard(),
  });
  gantt.service("stargantt.data").load(tasks);
</script>`}
        />

        <hr className="section-rule" />

        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Where to go</h2>
        <p className="lede" style={{ marginBottom: 14 }}>
          Three shapes of documentation, for three different questions.
        </p>
        <div className="grid-cards">
          <Card
            route={CORE[0] ? routes.core(CORE[0].slug) : undefined}
            title="Core concepts"
            body="How the kernel works: plugins, services, extension points, events, commands, and who owns what. Read this before writing a plugin of your own."
          />
          <Card
            route={GUIDES[0] ? routes.guide(GUIDES[0].slug) : undefined}
            title="Guides"
            body="Task-shaped walkthroughs you read top to bottom. Every code block is live — edit it, press Run, and the chart under it rebuilds."
          />
          <Card
            route={PLUGINS[0] ? routes.plugin(PLUGINS[0].id) : undefined}
            title="Reference"
            body="One page per plugin, sliced by API kind — config, services, events, commands, extension points. The complete surface, nothing implied."
          />
        </div>

        <hr className="section-rule" />

        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Every plugin</h2>
        <p className="lede" style={{ marginBottom: 12 }}>
          Some are in the standard preset and are already there when you call{" "}
          <code>presetStandard()</code>. The rest you add yourself, and they cost nothing until you
          do. Each plugin's page opens with the exact call for that plugin, so you never have to
          remember which is which.
        </p>
        {CATEGORY_ORDER.filter((c) => pluginsByCategory(c).length > 0).map((category) => (
          <section key={category} style={{ marginBottom: 14 }}>
            <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--fg-faint)" }}>
              {category}
            </h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {pluginsByCategory(category).map((plugin) => {
                const documented = isDocumented(plugin.id);
                return documented ? (
                  <a key={plugin.id} className="chip" href={href(routes.plugin(plugin.id))}>
                    {shortName(plugin.id)}
                  </a>
                ) : (
                  <span key={plugin.id} className="chip missing" title="Not documented yet">
                    {shortName(plugin.id)}
                  </span>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function Card({
  route,
  title,
  body,
}: {
  route: string | undefined;
  title: string;
  body: string;
}): React.JSX.Element {
  const card = (
    <div className="card">
      <div className="card-head">
        <span>{title}</span>
      </div>
      <div style={{ padding: 12, fontSize: 13, color: "var(--fg-muted)" }}>{body}</div>
    </div>
  );
  return route ? <a href={href(route)}>{card}</a> : card;
}
