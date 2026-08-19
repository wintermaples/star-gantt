import { useEffect, useMemo, useState } from "react";
import { GanttPreview } from "../components/GanttPreview";
import { RichParagraph, RichText } from "../components/RichText";
import { StaticCode } from "../components/StaticCode";
import { routes } from "../content/registry";
import type { DemoSpec, PluginDoc } from "../content/types";
import type { ApiMember, ApiPlugin } from "../generated/api";
import { pluginById, shortName } from "../generated/api";
import { oneLine } from "../lib/apiText";
import { printCall } from "../lib/printSpec";
import { currentQuery, href } from "../lib/router";

type TabId = "overview" | "config" | "services" | "events" | "commands" | "points" | "recipes";

const TAB_IDS: readonly TabId[] = [
  "overview",
  "config",
  "services",
  "events",
  "commands",
  "points",
  "recipes",
];

/**
 * The tab is addressable as `?tab=events`, so a link can land on one — which is what search results
 * for a service, event, command or extension point key do. An absent or unrecognised value opens
 * the overview, the same as arriving with no query at all.
 */
function initialTab(): TabId {
  const asked = currentQuery().get("tab");
  return TAB_IDS.find((id) => id === asked) ?? "overview";
}

/**
 * A plugin's reference page: the tabbed layout, one tab per kind of API surface.
 *
 * The tab strip is built from `api.json`, not from what the author happened to write about. A
 * surface that exists always has a tab; a surface that is empty gets a tab that says so. Neither
 * can be omitted, which is what makes the strip a coverage statement rather than a table of
 * contents.
 */
export function PluginPage({ doc }: { doc: PluginDoc }): React.JSX.Element {
  const api = pluginById(doc.id);
  const [tab, setTab] = useState<TabId>(initialTab);
  const spec = useMemo(
    () => (doc.overviewDemo.kind === "configured" ? doc.overviewDemo.spec : null),
    [doc],
  );

  // Arriving from a search result while already on this page changes the query but not the route,
  // so the component is re-rendered rather than remounted and the initial state above never runs
  // again. Without this, a hit on an event key would leave the reader looking at the overview tab.
  useEffect(() => {
    const onChange = (): void => setTab(initialTab());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  if (!api) {
    return (
      <div className="page">
        <div className="callout err">
          <b>{doc.id}</b> has a documentation page but no entry in <code>api.json</code>. Either the
          plugin was removed or the snapshot is stale — run <code>node tools/extract-api.ts</code>.
        </div>
      </div>
    );
  }

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "config", label: "Config" },
    { id: "services", label: "Services" },
    { id: "events", label: "Events" },
    { id: "commands", label: "Commands" },
    { id: "points", label: "Extension points" },
    { id: "recipes", label: "Recipes" },
  ];

  return (
    <div className="page narrow">
      <div className="crumb">
        Reference / {api.category} / {shortName(api.id)}
      </div>
      <h1>{api.id}</h1>
      <RichParagraph className="lede">{doc.summary}</RichParagraph>

      <div className="tabstrip" role="tablist" aria-label="API surface">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="btn"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? <Overview api={api} doc={doc} spec={spec} /> : null}
      {tab === "config" ? <Config api={api} doc={doc} /> : null}
      {tab === "services" ? <Members api={api} kind="services" members={api.services} doc={doc} /> : null}
      {tab === "events" ? <Members api={api} kind="events" members={api.events} doc={doc} /> : null}
      {tab === "commands" ? <Members api={api} kind="commands" members={api.commands} doc={doc} /> : null}
      {tab === "points" ? (
        <Members api={api} kind="extensionPoints" members={api.extensionPoints} doc={doc} />
      ) : null}
      {tab === "recipes" ? <Recipes doc={doc} /> : null}
    </div>
  );
}

function Overview({
  api,
  doc,
  spec,
}: {
  api: ApiPlugin;
  doc: PluginDoc;
  spec: DemoSpec | null;
}): React.JSX.Element {
  return (
    <>
      {doc.overview.map((para, i) => (
        <RichParagraph key={i}>{para}</RichParagraph>
      ))}
      <div className="callout">
        <b>When you need it: </b>
        <RichText>{doc.whenYouNeedIt}</RichText>
      </div>

      <h2 style={{ fontSize: 15, margin: "20px 0 6px" }}>Installing it</h2>
      <StaticCode source={installSnippet(api)} />

      <h2 style={{ fontSize: 15, margin: "20px 0 6px" }}>Dependencies</h2>
      {api.dependsOn.length === 0 ? (
        <p>
          None. This plugin talks to the kernel only, so it can be added to any composition without
          dragging anything else in.
        </p>
      ) : (
        <table className="api-table">
          <thead>
            <tr>
              <th>Requires</th>
            </tr>
          </thead>
          <tbody>
            {api.dependsOn.map((id) => (
              <tr key={id}>
                <td className="mono">
                  <a href={href(routes.plugin(id))}>{id}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ fontSize: 15, margin: "20px 0 6px" }}>What it looks like</h2>
      {/* Configured rather than at its defaults: for many plugins the defaults draw nothing, and a
          chart identical to one without the plugin teaches a reader nothing about it (D-23). */}
      {spec !== null && doc.overviewDemo.kind === "configured" ? (
        <>
          <p>
            The smallest configuration that shows what {shortName(api.id)} does. Every other option
            is on <a href={href(routes.pluginConfig(api.id))}>the config detail page</a>, which
            starts from this plugin at rest instead.
          </p>
          {/* `printCall`, not `printSpec`: an opt-in plugin's whole configuration lives in the
              spec's `plugins` builder, which `printSpec` prints as a placeholder — on exactly the
              pages where the extra plugin *is* the subject. */}
          <StaticCode source={spec.code ?? printCall(spec)} />
          <div style={{ marginTop: 12 }}>
            <GanttPreview spec={spec} caption={doc.overviewDemo.caption} />
          </div>
        </>
      ) : doc.overviewDemo.kind === "none" ? (
        <div className="callout warn" data-testid="overview-no-demo">
          <b>No live chart for this one. </b>
          <RichText>{doc.overviewDemo.reason}</RichText>
        </div>
      ) : null}
    </>
  );
}

function Config({ api, doc }: { api: ApiPlugin; doc: PluginDoc }): React.JSX.Element {
  if (api.config.length === 0) {
    return (
      <div className="callout warn">
        <b>This plugin takes no options.</b> Its behaviour is fixed, so there is nothing to pass to{" "}
        <code>{api.factory ?? "the factory"}()</code> beyond calling it.
      </div>
    );
  }
  const generated = new Map(api.config.map((option) => [option.name, option]));
  return (
    <>
      <p>
        <code>{api.configType}</code> is the option object{" "}
        {api.inPresetStandard ? (
          <>
            forwarded through <code>presetStandard()</code>
          </>
        ) : (
          <>
            passed to <code>{api.factory}()</code>
          </>
        )}
        . Every option is optional; omitting one leaves that feature at its default.
      </p>
      <p>
        This table is the index. For what each value looks like, open{" "}
        <a href={href(routes.pluginConfig(api.id))}>the config detail page</a>, which pins a chart
        beside the prose and re-applies each option as you read it.
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>Option</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          {doc.properties.map((written) => {
            const option = generated.get(written.name);
            return (
              <tr key={written.name}>
                <td className="mono">
                  <a href={`${href(routes.pluginConfig(api.id))}?p=${written.name}`}>{written.name}</a>
                </td>
                <td className="mono">{oneLine(option?.type ?? "unknown")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

const KIND_LABEL: Record<string, string> = {
  services: "services",
  events: "events",
  commands: "commands",
  extensionPoints: "extension points",
};

/**
 * Why an empty surface still renders a page: an absent tab is indistinguishable from an
 * unfinished one. Stating that a plugin emits no events is information; leaving the reader to
 * infer it from a missing tab is not.
 */
function Members({
  api,
  kind,
  members,
  doc,
}: {
  api: ApiPlugin;
  kind: keyof NonNullable<PluginDoc["notes"]>;
  members: readonly ApiMember[];
  doc: PluginDoc;
}): React.JSX.Element {
  const notes = doc.notes?.[kind] ?? {};
  if (members.length === 0) {
    return (
      <div className="callout warn">
        <b>This plugin defines no {KIND_LABEL[kind]}.</b>{" "}
        <RichText>
          {notes["__empty"] ??
            "Stated rather than left out: an absent section would read the same as an unfinished one."}
        </RichText>
      </div>
    );
  }
  return (
    <>
      {members.map((member) => (
        <section key={member.key} style={{ marginBottom: 18 }}>
          <div className="badge-row" style={{ margin: "0 0 6px" }}>
            <span className="propname">{member.key}</span>
          </div>
          <pre className="code">{`${member.key}: ${member.type}`}</pre>
          {member.doc ? (
            <p style={{ marginTop: 8 }}>
              <RichText>{firstParagraph(member.doc)}</RichText>
            </p>
          ) : null}
          {notes[member.key] ? (
            <div className="callout">
              <RichText>{notes[member.key]!}</RichText>
            </div>
          ) : null}
        </section>
      ))}
      <p style={{ color: "var(--fg-faint)", fontSize: 12 }}>
        Signatures above are the declarations {api.package} merges into the kernel's key space.
      </p>
    </>
  );
}

function Recipes({ doc }: { doc: PluginDoc }): React.JSX.Element {
  if (doc.recipes.length === 0) {
    return <div className="callout warn">No recipes written for this plugin yet.</div>;
  }
  return (
    <>
      {doc.recipes.map((recipe) => (
        <section key={recipe.title} style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, marginBottom: 4 }}>{recipe.title}</h2>
          <RichParagraph>{recipe.intent}</RichParagraph>
          <StaticCode source={recipe.code} />
        </section>
      ))}
    </>
  );
}

function installSnippet(api: ApiPlugin): string {
  if (api.inPresetStandard) {
    return `// Already in the standard preset — nothing to add.
const gantt = StarGantt.create({
  element: document.getElementById("chart"),
  plugins: StarGantt.presetStandard(),
});`;
  }
  return `// Opt-in: append it after the preset.
const gantt = StarGantt.create({
  element: document.getElementById("chart"),
  plugins: [
    ...StarGantt.presetStandard(),
    StarGantt.${api.factory ?? "plugin"}(),
  ],
});`;
}

const firstParagraph = (doc: string): string => doc.split("\n\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
