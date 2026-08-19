import { GanttPreview } from "../components/GanttPreview";
import { RichParagraph } from "../components/RichText";
import { StaticCode } from "../components/StaticCode";
import type { CoreDoc } from "../content/types";

/**
 * A core chapter. The kernel has no options to demonstrate, so these pages are prose plus code and
 * the occasional chart — a chapter's runnable cell usually shows a plugin being written, not a
 * value being changed.
 */
export function CorePage({ doc }: { doc: CoreDoc }): React.JSX.Element {
  return (
    <div className="page narrow">
      <div className="crumb">Core concepts</div>
      <h1>{doc.title}</h1>
      <RichParagraph className="lede">{doc.lede}</RichParagraph>
      <hr className="section-rule" />

      {doc.cells.map((cell, i) => {
        if (cell.kind === "prose") {
          return (
            <div key={i}>
              {cell.paragraphs.map((para, j) => (
                <RichParagraph key={j}>{para}</RichParagraph>
              ))}
            </div>
          );
        }
        if (cell.kind === "code") {
          return (
            <div key={i} style={{ margin: "0 0 16px" }}>
              <StaticCode source={cell.source} {...(cell.caption ? { caption: cell.caption } : {})} />
            </div>
          );
        }
        return (
          <div key={i} style={{ margin: "0 0 16px" }}>
            <GanttPreview spec={cell.spec} {...(cell.caption ? { caption: cell.caption } : {})} />
          </div>
        );
      })}
    </div>
  );
}
