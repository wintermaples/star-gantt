import { Suspense, lazy } from "react";
import type { CodeEditorProps } from "./CodeEditor";

/**
 * CodeMirror, off the critical path.
 *
 * The editor is on every config page and every guide, but it is never the first thing a reader
 * looks at and it is a large dependency to put ahead of the prose. Loading it in its own chunk lets
 * the page paint first; the fallback is a plain block of the same text at the same size, so the
 * swap is a change of colour rather than a change of layout.
 */
const CodeEditor = lazy(async () => ({ default: (await import("./CodeEditor")).CodeEditor }));

export function LazyCodeEditor(props: CodeEditorProps): React.JSX.Element {
  return (
    <Suspense fallback={<pre className="cm-fallback">{props.value}</pre>}>
      <CodeEditor {...props} />
    </Suspense>
  );
}
