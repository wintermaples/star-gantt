import { transform } from "sucrase";
import type { DemoSpec } from "../content/types";

export type EvalResult = { ok: true; value: DemoSpec } | { ok: false; error: string };

/**
 * Turns the text of a notebook cell into a live demo.
 *
 * A cell is a TypeScript *expression* evaluating to a `DemoSpec`. Type annotations and `satisfies`
 * clauses are stripped by sucrase, so what is on screen can be exactly what a reader would paste
 * into their own project. `StarGantt` is in scope under the same name the script tag gives it, so
 * an opt-in plugin is added the same way in the docs and in a real page.
 *
 * Deliberately unsandboxed: the code is authored in this repository and readers only ever edit
 * their own browser tab. Not a place to run input from anywhere else.
 */
export function evalDemo(source: string, api: unknown): EvalResult {
  let js: string;
  try {
    js = transform(`(${source.trim()})`, {
      transforms: ["typescript"],
      disableESTransforms: true,
    }).code;
  } catch (cause) {
    return { ok: false, error: describe(cause) };
  }

  try {
    const value: unknown = new Function("StarGantt", `"use strict"; return ${js};`)(api);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "A cell must evaluate to an object, e.g. { preset: { taskBars: { … } } }" };
    }
    return { ok: true, value: value as DemoSpec };
  } catch (cause) {
    return { ok: false, error: describe(cause) };
  }
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
