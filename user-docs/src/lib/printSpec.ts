import type { DemoSpec } from "../content/types";

/**
 * Kept apart from `evalDemo` so that showing a config costs nothing to load.
 *
 * `evalDemo` pulls in sucrase to compile a cell's TypeScript; this only formats an object. They
 * lived in one module and every config page therefore shipped a compiler it never runs.
 */
/** Renders a demo's config the way a reader would paste it, naming functions rather than dumping them. */
export function printSpec(spec: DemoSpec): string {
  if (spec.code) return spec.code;
  const extra = spec.plugins ? "\n  ...extraPlugins," : "";
  return `plugins: [\n  ...StarGantt.presetStandard(${indent(printPreset(spec.preset))}),${extra}\n]`;
}

/**
 * The whole call a demo stands for — what a reader would write to get the chart beside it.
 *
 * A notebook cell holds a `DemoSpec`, which is this site's own shape and appears nowhere in a
 * reader's project. Printing the call keeps that shape from being the only thing on screen: the
 * cell is the part worth editing, and this is where the edit lands.
 */
export function printCall(spec: DemoSpec): string {
  const preset = printPreset(spec.preset);
  const presetArg = preset === "{}" ? "" : indent(indent(preset));
  const lines = [
    "const gantt = StarGantt.create({",
    '  element: document.getElementById("chart"),',
    "  plugins: [",
    `    ...StarGantt.presetStandard(${presetArg}),`,
    ...printExtraPlugins(spec.plugins),
    "  ],",
    "});",
    "",
    'gantt.service("stargantt.data").load(tasks);',
  ];
  return lines.join("\n");
}

/**
 * `plugins` is a function of the bundle namespace, so its own source is the only record of which
 * factories it calls. Rewriting the parameter to `StarGantt` turns it back into the call a reader
 * would make, and keeps the author's line breaks.
 *
 * Anything that is not a plain arrow returning an array is printed as a placeholder rather than
 * guessed at — a wrong listing next to a working chart is worse than an unspecific one.
 */
function printExtraPlugins(plugins: DemoSpec["plugins"]): readonly string[] {
  if (!plugins) return [];
  const source = plugins.toString();
  const arrow = /^\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/.exec(source);
  const open = source.indexOf("[");
  const close = source.lastIndexOf("]");
  if (!arrow?.[1] || open === -1 || close <= open) return ["    ...extraPlugins,"];
  const body = source
    .slice(open + 1, close)
    .replace(new RegExp(`\\b${arrow[1]}\\s*\\.`, "g"), "StarGantt.");
  const lines = dedent(body);
  const last = lines[lines.length - 1];
  if (last !== undefined && !last.endsWith(",")) lines[lines.length - 1] = `${last},`;
  return lines.map((line) => `    ${line}`);
}

/** Drops blank edges and the indentation the author's own source happened to carry. */
function dedent(text: string): string[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const pad = Math.min(...lines.map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(pad).trimEnd());
}

/**
 * The preset config as source rather than as JSON: quoted keys are what `JSON.stringify` produces
 * and not what anyone writes. Only keys that are already valid identifiers are unquoted, so a key
 * needing quotes keeps them.
 */
function printPreset(preset: DemoSpec["preset"]): string {
  return JSON.stringify(
    preset ?? {},
    (_key, value: unknown) => (typeof value === "function" ? "«fn»" : value),
    2,
  )
    .replace(/"«fn»"/g, "(…) => …")
    .replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:");
}

const indent = (text: string): string => text.split("\n").join("\n  ");
