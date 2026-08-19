import type { CodeLanguage } from "./CodeEditor";
import { LazyCodeEditor } from "./LazyCodeEditor";
import { RichText } from "./RichText";

export interface StaticCodeProps {
  source: string;
  /** Defaults to TypeScript, which most listings on the site are. */
  language?: CodeLanguage;
  /** Small line under the listing. Supports `code` spans, like every other authored string. */
  caption?: string;
  className?: string;
}

/**
 * A listing the reader copies rather than edits.
 *
 * It is the same editor the runnable cells use, held read-only, rather than a second highlighter
 * written for static text: the two then agree about what a keyword looks like, and a listing gains
 * nothing a reader has to be taught. Read-only means the content is not editable and not a tab
 * stop, so a reference page carrying a dozen recipes does not become a dozen stops on the way to
 * the next link.
 *
 * The editor arrives in its own chunk (`LazyCodeEditor`), and until it does the text is on screen
 * as a plain block of the same size — the swap is a change of colour, not of layout.
 */
export function StaticCode({ source, language = "ts", caption, className }: StaticCodeProps): React.JSX.Element {
  return (
    <figure className={className ? `static-code ${className}` : "static-code"}>
      <LazyCodeEditor value={source} onChange={() => undefined} readOnly language={language} />
      {caption ? (
        <figcaption className="cell-caption">
          <RichText>{caption}</RichText>
        </figcaption>
      ) : null}
    </figure>
  );
}
