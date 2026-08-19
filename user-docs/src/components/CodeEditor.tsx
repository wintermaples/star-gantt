import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
  type LanguageSupport,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

// Colours are pulled from the docs-site tokens rather than a CodeMirror theme package, so the
// editor follows the same light/dark switch as the rest of the page.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword], color: "var(--cm-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--cm-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--cm-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--cm-prop)" },
  { tag: [t.typeName, t.className], color: "var(--cm-type)" },
  // HTML and CSS reach for tags the TypeScript grammar never emits. Without these an element name
  // and its attributes come out the same colour as the text between them, which is the state a
  // plain `<pre>` was already in.
  { tag: [t.tagName, t.angleBracket], color: "var(--cm-keyword)" },
  { tag: [t.attributeName], color: "var(--cm-type)" },
  { tag: [t.attributeValue], color: "var(--cm-string)" },
]);

/** The grammars a listing on this site can be written in. Cells default to TypeScript. */
export type CodeLanguage = "ts" | "html" | "css";

// `html()` carries the CSS and JavaScript grammars for embedded `<style>` and `<script>`, which is
// what the complete-page listing in `your-first-chart` is made of.
const LANGUAGES: Record<CodeLanguage, () => LanguageSupport> = {
  ts: () => javascript({ typescript: true }),
  html: () => html(),
  css: () => css(),
};

const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--fg)" },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent-soft)",
  },
});

export interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Read-only editors are used for the generated "here is your whole config" panes. */
  readOnly?: boolean;
  minHeight?: number;
  /** Bound to Ctrl/Cmd+Enter, so the cell can be run without leaving the keyboard. */
  onRun?: (() => void) | undefined;
  /** Grammar to highlight with. Defaults to TypeScript, which every editable cell is. */
  language?: CodeLanguage;
}

/**
 * A CodeMirror 6 editor wired as an uncontrolled component: React owns the initial document and is
 * told about edits, but never pushes its state back on every keystroke — doing so would fight the
 * editor's own undo history and cursor.
 */
export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  minHeight = 0,
  onRun,
  language = "ts",
}: CodeEditorProps): React.JSX.Element {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;
  // Read through a ref for the same reason `onChange` is: the editor is created once, and a
  // keymap captured at creation would go on calling the first render's handler forever.
  const run = useRef(onRun);
  run.current = onRun;

  useEffect(() => {
    const parent = mount.current;
    if (!parent) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(highlight),
        LANGUAGES[language](),
        // Ahead of the default keymap, which binds Enter on its own.
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              if (!run.current) return false;
              run.current();
              return true;
            },
          },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        theme,
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current(update.state.doc.toString());
        }),
      ],
    });
    const editor = new EditorView({ state, parent });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The document is seeded once; later `value` changes from outside are pushed in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, language]);

  // Only relevant for read-only panes (the generated config view) and for "Reset".
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div className="editor" ref={mount} style={minHeight ? { minHeight } : undefined} />;
}
