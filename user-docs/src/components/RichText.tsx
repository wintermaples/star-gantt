import { segmentsOf } from "../lib/inline";

/**
 * Renders one string of hand-written prose, turning its `code` spans into <code>.
 *
 * Every place the site prints an author's sentence goes through this — guide paragraphs, plugin
 * overviews, per-option prose, callouts, captions and the generated TSDoc alike — so a reader never
 * has to work out whether a particular page happens to support the marks.
 */
export function RichText({ children }: { children: string }): React.JSX.Element {
  return (
    <>
      {segmentsOf(children).map((segment, i) =>
        segment.code ? <code key={i}>{segment.text}</code> : <span key={i}>{segment.text}</span>,
      )}
    </>
  );
}

/** The common case: a whole paragraph of it. */
export function RichParagraph({
  children,
  className,
}: {
  children: string;
  className?: string;
}): React.JSX.Element {
  return (
    <p {...(className ? { className } : {})}>
      <RichText>{children}</RichText>
    </p>
  );
}
