/**
 * The playground shell's test hook, `window.__pg`. Declared ambiently rather than in a spec file so
 * that both `playground-shell.spec.ts` and `playground-chrome.spec.ts` — and any future spec — see
 * one shape instead of racing duplicate `declare global` blocks.
 *
 * STATUS: `examples/playground.js`, the implementation this shape was read off, does not exist in
 * this repository. No `examples/*.html` page carries the `<script id="demo-code"
 * type="text/stargantt-demo">` block its own top-level guard requires, so the shell is not wired
 * into any page. This file's shape is kept only as a historical transcription — it cannot be
 * re-verified against a live implementation, and nothing in `e2e/` currently exercises it
 * (`e2e/oa/oa.spec.ts` boots directly against `examples/hello.html` rather than depend on this
 * shell — see that file's header for why). Recreating the shell for real would mean writing a new
 * implementation against `docs/specs/`, then adding a `#demo-code` block to whichever page(s)
 * should carry it.
 */
interface StarGanttPlaygroundHook {
  /** The live `GanttInstance`, or `null` between a failed boot and the next successful one. */
  instance: unknown;
  /** Re-run the demo source: the given code, else the drawer's current text. Synchronous. */
  run(code?: string): unknown;
  /** Swap the dataset: a `datasets.js` preset id, or a raw dataset object. */
  applyDataset(presetIdOrObject: string | object): unknown;
  /** Re-render the chrome from `html` (or the HTML pane's current text), then reboot. */
  applyChrome(html?: string): unknown;
  /** Restore the original three sources, the default dataset and the original control values. */
  reset(): unknown;
  editorMode: "codemirror" | "textarea";
  /** A live view of the three editors' current text. */
  sources: { js: string; html: string; data: string };
}

interface Window {
  __pg?: StarGanttPlaygroundHook;
}
