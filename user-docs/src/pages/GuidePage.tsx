import type { CodeLanguage } from "../components/CodeEditor";
import { ProseCell, RunnableCell } from "../components/NotebookCell";
import { RichParagraph, RichText } from "../components/RichText";
import { StaticCode } from "../components/StaticCode";
import { routes } from "../content/registry";
import type { GuideDoc } from "../content/types";
import { PLUGINS, shortName } from "../generated/api";
import { href } from "../lib/router";

/**
 * A guide, in the notebook layout: prose cell, editable demo cell, live output cell.
 *
 * The rule the layout carries is that no explanation ships without something runnable beneath it.
 * A guide made only of prose cells is possible and is exactly what the coverage test rejects.
 */
export function GuidePage({ doc }: { doc: GuideDoc }): React.JSX.Element {
  return (
    <div className="page narrow">
      <div className="crumb">Guides</div>
      <h1>{doc.title}</h1>
      <RichParagraph className="lede">{doc.lede}</RichParagraph>
      <hr className="section-rule" />

      {doc.cells.map((cell, i) => {
        if (cell.kind === "prose") {
          return (
            <ProseCell key={i}>
              {cell.paragraphs.map((para, j) => (
                <RichParagraph key={j}>{para}</RichParagraph>
              ))}
            </ProseCell>
          );
        }
        if (cell.kind === "code") {
          const label = cell.label ?? "ts";
          return (
            <div className="cell" key={i}>
              <div className="cell-kind">{label}</div>
              <div className="cell-body">
                <StaticCode
                  source={cell.source}
                  language={languageOf(label)}
                  {...(cell.caption ? { caption: cell.caption } : {})}
                />
              </div>
            </div>
          );
        }
        if (cell.kind === "callout") {
          return (
            <div key={i} className={`callout${cell.tone === "warn" ? " warn" : ""}`} style={{ margin: "4px 0 14px 56px" }}>
              <RichText>{cell.body}</RichText>
            </div>
          );
        }
        return (
          <RunnableCell
            key={i}
            source={cell.source}
            {...(cell.height ? { height: cell.height } : {})}
            {...(cell.caption ? { caption: cell.caption } : {})}
          />
        );
      })}

      {doc.next.length > 0 ? (
        <>
          <hr className="section-rule" />
          <p>
            Next:{" "}
            {doc.next.map((route, i) => (
              <span key={route}>
                {i > 0 ? " · " : ""}
                <a href={href(route)}>{labelFor(route)}</a>
              </span>
            ))}
          </p>
        </>
      ) : null}
    </div>
  );
}

/**
 * A code cell's gutter label doubles as its grammar. Anything else — a label naming what the
 * listing *is* rather than what it is written in — is highlighted as TypeScript, which is what the
 * cell type documents as its default.
 */
function languageOf(label: string): CodeLanguage {
  return label === "html" || label === "css" ? label : "ts";
}

/** Turns a route back into something readable, so a guide's "next" list needs no duplicate titles. */
function labelFor(route: string): string {
  const plugin = PLUGINS.find(
    (p) => routes.plugin(p.id) === route || routes.pluginConfig(p.id) === route,
  );
  if (plugin) {
    return route.endsWith("/config") ? `${shortName(plugin.id)} · Config` : shortName(plugin.id);
  }
  return route.replace(/^\/(guides|core)\//, "").replace(/-/g, " ");
}
