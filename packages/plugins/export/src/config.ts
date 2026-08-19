// docs/specs/plugins/export.md §7 — the factory config and its one resolution pass.
/**
 * `ExportConfig` and its normalization.
 *
 * Nesting per the spec's §7 table; all fields optional; unusable values silently fall back;
 * resolved once at `setup()`.
 *
 * The `image` and `print` nests are deliberately NOT validated here. Both are per-call overridable
 * per key (§1, "Option resolution"), so validation happens in the same pass that merges a call's
 * options over the nest: `resolveImageOptions` in `./index.ts` for the image nest, and
 * `resolveOptions` in `./internal/print/layout.ts` for the print nest — the pattern the spec names
 * as the precedent. Both spread the call over the nest and then validate the merged
 * value once per key, so a call that SUPPLIES a key with an unusable value lands on the built-in
 * default rather than on the nest's value; only a key the call omits keeps the nest's. Validating
 * the nest a second time here would be dead work that could only diverge from those two rules.
 */
import type { ExportMessages } from "./internal/messages";
import type { ImageCaptureConfig, PrintOptions } from "./types";

export interface ExportConfig {
  messages?: Partial<ExportMessages>;
  image?: ImageCaptureConfig;
  /**
   * Factory-level print defaults; each `PrintOptions` call overrides per key. (Resolution note in
   * the spec: the design card writes `print?: {}`, but that's read as an elision — this type
   * carries real factory `PrintOptions` defaults.)
   */
  print?: PrintOptions;
  importExport?: {
    /** Field separator for `exportCsv` and `importCsv`. Single character; default `","`. */
    csvDelimiter?: string;
  };
  excel?: {
    /** Worksheet name, sanitized per §1.8. Default `"Tasks"`. */
    sheetName?: string;
  };
  viewerEmbed?: {
    /** Default false (`embed` flips the default — §2.3). */
    readOnly?: boolean;
    /** Default false. */
    embed?: boolean;
    /** Default `"sg-snapshot"`. */
    snapshotParam?: string;
    /** Default false. */
    autoRestore?: boolean;
    /** Adds to the built-in exempt set — §2.1. */
    readOnlyExemptOrigins?: readonly string[];
  };
}

/** The config nests after normalization: every nest is an object, never `undefined`. */
export interface ResolvedConfig {
  /** Carried through unresolved: `internal/messages` owns the per-key merge and its fault latch. */
  messages: Partial<ExportMessages> | undefined;
  image: ImageCaptureConfig;
  print: PrintOptions;
  importExport: { csvDelimiter: string };
  excel: { sheetName: string };
  viewerEmbed: {
    readOnly: boolean;
    embed: boolean;
    snapshotParam: string;
    autoRestore: boolean;
    readOnlyExemptOrigins: readonly string[];
  };
}

/** The `image` nest's own defaults; every field stays optional (each has its own §1.1 fallback). */
const NO_IMAGE: ImageCaptureConfig = {};

function nest(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** A single character, else `undefined`. */
function singleChar(value: unknown): string | undefined {
  return typeof value === "string" && value.length === 1 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Normalizes the factory config once, at `setup()`.
 *
 * The `image` and `print` nests are carried through as-is: both are per-call overridable per key,
 * so their validation happens in the same pass that merges the call's options over them — running
 * it twice would let a factory-level unusable value be dropped before the call could see (and
 * override) it, which is not what "per-key shallow override" means.
 */
export function resolveConfig(config: ExportConfig | undefined): ResolvedConfig {
  const c = nest(config);
  const importExport = nest(c["importExport"]);
  const excel = nest(c["excel"]);
  const viewerEmbed = nest(c["viewerEmbed"]);

  const embed = bool(viewerEmbed["embed"], false);
  const origins = viewerEmbed["readOnlyExemptOrigins"];

  return {
    messages:
      c["messages"] !== null && typeof c["messages"] === "object"
        ? (c["messages"] as Partial<ExportMessages>)
        : undefined,
    image: (c["image"] !== null && typeof c["image"] === "object"
      ? (c["image"] as ImageCaptureConfig)
      : NO_IMAGE),
    print: c["print"] !== null && typeof c["print"] === "object" ? (c["print"] as PrintOptions) : {},
    importExport: { csvDelimiter: singleChar(importExport["csvDelimiter"]) ?? "," },
    excel: { sheetName: nonEmptyString(excel["sheetName"]) ?? "Tasks" },
    viewerEmbed: {
      // §2.3 — `embed` flips the default only; an explicit `readOnly` still wins.
      readOnly: bool(viewerEmbed["readOnly"], embed),
      embed,
      snapshotParam: nonEmptyString(viewerEmbed["snapshotParam"]) ?? "sg-snapshot",
      autoRestore: bool(viewerEmbed["autoRestore"], false),
      // §2.1 — a non-array is ignored; non-string entries are dropped per element.
      readOnlyExemptOrigins: Array.isArray(origins)
        ? origins.filter((o): o is string => typeof o === "string")
        : [],
    },
  };
}
