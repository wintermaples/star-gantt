import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DemoSpec, StarGanttApi } from "../content/types";
import type { EvalResult } from "../lib/evalDemo";
import { printCall } from "../lib/printSpec";
import { loadStarGantt } from "../lib/stargantt";
import { LazyCodeEditor } from "./LazyCodeEditor";
import { GanttPreview } from "./GanttPreview";
import { StaticCode } from "./StaticCode";

/**
 * The cell compiler and the bundle it evaluates against, both fetched on demand.
 *
 * `evalDemo` carries sucrase, which exists to strip type annotations from a cell a reader may never
 * edit; the bundle is the library itself. Neither belongs ahead of the prose the reader came for.
 */
let toolchain: Promise<{ evalDemo: (source: string, api: unknown) => EvalResult; api: StarGanttApi }> | undefined;

function loadToolchain(): NonNullable<typeof toolchain> {
  toolchain ??= Promise.all([import("../lib/evalDemo"), loadStarGantt()]).then(([module, api]) => ({
    evalDemo: module.evalDemo,
    api,
  }));
  return toolchain;
}

/**
 * Whether the "call this makes" panes are open, shared by every cell on the site.
 *
 * A guide holds up to six runnable cells and they all answer the same question — what a cell's
 * object turns into. A reader who asks it once has asked it for the page, so opening one opens the
 * rest. Held in memory only: it is a reading preference for this visit, not a setting.
 */
let callsOpen = false;
const callListeners = new Set<() => void>();

function setCallsOpen(next: boolean): void {
  if (callsOpen === next) return;
  callsOpen = next;
  for (const listener of callListeners) listener();
}

function useCallsOpen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      callListeners.add(onChange);
      return () => callListeners.delete(onChange);
    },
    () => callsOpen,
    () => false,
  );
}

export function ProseCell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="cell">
      <div className="cell-kind">md</div>
      <div className="cell-body">{children}</div>
    </div>
  );
}

export interface RunnableCellProps {
  /** Initial cell text: a TypeScript expression evaluating to a `DemoSpec`. */
  source: string;
  height?: number;
  caption?: string;
}

/**
 * An editable demo cell and the chart it produces.
 *
 * The cell runs once on its own so a reader who only reads sees a working chart, and after that
 * only when Run is pressed (or Ctrl/Cmd+Enter). Re-running per keystroke was the earlier
 * behaviour and it rebuilt a whole gantt instance on every character — including the half-typed
 * ones, which cost a compile and a mount to produce an error the reader was already about to fix.
 */
export function RunnableCell({ source, height = 300, caption }: RunnableCellProps): React.JSX.Element {
  const [text, setText] = useState(source);
  // The text that is actually on screen below. `text` is what the editor holds; this is what ran.
  const [running, setRunning] = useState(source);
  const [result, setResult] = useState<EvalResult | null>(null);
  const dirty = text !== running;
  const showCall = useCallsOpen();

  // Evaluated once the toolchain has arrived, and again whenever a run is asked for. Until then
  // the cell shows its text and an empty chart frame rather than an error: nothing is wrong, the
  // compiler is in flight.
  useEffect(() => {
    let current = true;
    void loadToolchain().then(({ evalDemo, api }) => {
      if (current) setResult(evalDemo(running, api));
    });
    return () => {
      current = false;
    };
  }, [running]);

  // The last spec that compiled, so a half-typed line leaves the previous chart on screen instead
  // of blanking the output.
  const lastGood = useRef<DemoSpec>({});
  if (result?.ok) lastGood.current = result.value;
  const spec = result?.ok ? result.value : lastGood.current;

  return (
    <>
      <div className="cell">
        <div className="cell-kind">ts ▸</div>
        <div className="cell-body">
          <div className="card">
            <div className="card-head">
              <span>demo.ts</span>
              <span className="spacer" />
              {dirty ? <span className="hint">edited — press Run</span> : null}
              {text !== source ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setText(source);
                    setRunning(source);
                  }}
                >
                  Reset
                </button>
              ) : null}
              <button
                type="button"
                className="btn primary"
                disabled={!dirty}
                title="Run this cell (Ctrl+Enter)"
                onClick={() => setRunning(text)}
              >
                ▶ Run
              </button>
            </div>
            <LazyCodeEditor value={text} onChange={setText} onRun={() => setRunning(text)} />
          </div>
          {result === null || result.ok ? null : (
            <div className="callout err" style={{ marginTop: 8 }} role="alert">
              {result.error}
            </div>
          )}
          {/*
            The cell above is a `DemoSpec` — this site's own shape, which appears nowhere in a
            reader's project. This is what the page does with it, generated from the spec that
            actually ran, so an edited cell answers for itself.
          */}
          <details
            className="call-made"
            open={showCall}
            onToggle={(event) => setCallsOpen(event.currentTarget.open)}
          >
            <summary>the call this makes</summary>
            {/* Built only once asked for. A closed `<details>` still renders its children, and six
                hidden editors per guide is six editors mounted against a box with no size. */}
            {showCall ? <StaticCode source={printCall(spec)} /> : null}
          </details>
        </div>
      </div>
      <div className="cell">
        <div className="cell-kind">out</div>
        <div className="cell-body">
          <GanttPreview spec={spec} height={height} {...(caption ? { caption } : {})} />
        </div>
      </div>
    </>
  );
}
