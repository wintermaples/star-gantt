/**
 * Extracts every CSS custom property the library declares, publishes or has retired, and writes it
 * to `src/generated/tokens.json`.
 *
 * The site needs one page that lists **all** of them, because a reader who wants to restyle a
 * chart has no other way to find out what there is to restyle: a token is not an export, it does
 * not appear in `api.json`, and a name that is merely absent from the documentation looks exactly
 * like a name that does not exist. So this walks the same sources the library's own conformance
 * test walks and classifies every `--sg-*` it finds. A token it cannot classify stops the
 * extraction rather than being dropped — an unclassified token is the one failure this file exists
 * to prevent.
 *
 * The sources, and why each is the one used:
 *
 * - `packages/stargantt/src/styles/tokens.css` and `styles/layout.css` — the bundled stylesheet
 *   splits into three parts (`index.ts` concatenates `tokens.css` + `layout.css` +
 *   `plugins.css`). `tokens.css` carries every `@property` registration (which says what kind of
 *   value a token holds, and its light-only fallback for a host that drops the stylesheet
 *   entirely); `layout.css` carries the one rule, applied to `:where(:root)` and both scheme
 *   classes, that declares every token's real value — `light-dark(light, dark)` where the two
 *   schemes differ, a bare value where they do not. There is no separate normative registry
 *   document: the stylesheet *is* the registry, so this reads it directly rather than a
 *   hand-maintained table that could drift from it.
 * - `packages/plugins/view/src/internal/theme/` — the canvas-read set (a painter reads these
 *   through `ThemeService.get`, so a self-contained palette has to cover them), the forced-colors
 *   mapping, and the retired names a host may still have in its stylesheet. Theming lives inside
 *   the `view` plugin, alongside four other basic-tier features it covers.
 * - `packages/plugins/view/src/internal/render/safearea.ts` — the four properties the renderer
 *   *publishes* rather than reads. They have no declaration and no default, and they are the only
 *   tokens that flow outward, so a reader who meets one in a stylesheet needs to be told that.
 * - Which plugin *reads* a token (the `readers` list on each row) is derived the same way the
 *   `group` is: by scanning every plugin package's own sources for the token's name. There is no
 *   registry table with an attribution column, so this is the only source there is — and it is a
 *   fact about the code rather than an editor's transcription of one.
 *
 * The output is committed and `test/tokens.test.ts` re-runs this and fails on any difference, the
 * same rule `api.json` follows (docs-policy.md D-05, D-24).
 *
 * Run: node tools/extract-tokens.ts        (Node strips the types; no build step)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(HERE, "..");
const REPO_ROOT = join(DOCS_ROOT, "..");
const PACKAGES = join(REPO_ROOT, "packages");
const PLUGIN_PACKAGES = join(PACKAGES, "plugins");
const STYLE_DIR = join(PACKAGES, "stargantt/src/styles");
const TOKENS_CSS = join(STYLE_DIR, "tokens.css");
const LAYOUT_CSS = join(STYLE_DIR, "layout.css");
const THEME_INTERNAL = join(PLUGIN_PACKAGES, "view/src/internal/theme");
const SAFE_AREA = join(PLUGIN_PACKAGES, "view/src/internal/render/safearea.ts");
const OUT = join(DOCS_ROOT, "src/generated/tokens.json");

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/** What kind of value a token holds, which is what a host has to write to override it. */
export type TokenKind = "color" | "length" | "number" | "font" | "text";

export interface TokenDoc {
  /** The custom property, with its leading dashes: `--sg-bar-fill`. */
  name: string;
  /** The group this token is listed under on the page. */
  group: string;
  kind: TokenKind;
  /** The value the stylesheet declares for the light scheme. */
  light: string;
  /** The dark-scheme value, or `null` when the token is deliberately identical in both. */
  dark: string | null;
  /**
   * Whether a canvas painter reads this token through `ThemeService.get` — which is what makes it
   * part of the set a replacement palette has to cover in full.
   */
  canvasRead: boolean;
  /** The CSS system color this token becomes while forced colors are active, if it is mapped. */
  forcedColor: string | null;
  /** Plugin short names that read it, in the order the registry lists them. Empty: stylesheet only. */
  readers: string[];
  /** The registry's own parenthetical about this row, or `""`. Never a restatement of the value. */
  note: string;
}

/** A stylesheet-internal property derived from other tokens: it carries no value of its own. */
export interface DerivedToken {
  name: string;
  /** The declaration, verbatim — the derivation *is* the explanation. */
  value: string;
}

/** A property the renderer writes as an output of its layout, rather than one a host sets. */
export interface PublishedToken {
  name: string;
}

/** A name the library no longer declares, and what replaces it. */
export interface RetiredToken {
  name: string;
  advice: string;
}

export interface TokenGroup {
  id: string;
  /**
   * How the group was formed: `base` is the chart's own surface, `plugin` is a group the registry
   * attributes to a reading plugin, and `family` is a name prefix shared by tokens the stylesheet
   * consumes itself. The page uses this only to order the groups.
   */
  kind: "base" | "plugin" | "family";
  tokens: string[];
}

export interface TokenSnapshot {
  /** Bumped by hand when the shape of this file changes, so a stale checkout fails loudly. */
  schemaVersion: number;
  groups: TokenGroup[];
  tokens: TokenDoc[];
  derived: DerivedToken[];
  published: PublishedToken[];
  retired: RetiredToken[];
}

/* ------------------------------------------------------------------ *
 * Reading the sources
 * ------------------------------------------------------------------ */

/**
 * Every `--sg-*` name that appears anywhere in the library's sources.
 *
 * Deliberately a text scan rather than a parse: a token is a string in CSS, a string literal in
 * TypeScript and a `var()` inside a template literal, so there is no one syntax to walk. The scan
 * is what backs the guarantee this page exists for — a name that appears in the library and not on
 * the page is a failure, and the only way to know is to look everywhere.
 *
 * Two shapes are prose rather than tokens, and the pattern excludes both: a name carrying an
 * uppercase letter (`--sg-CORE-TOKEN`, standing in for whatever a host might pick) and a name a
 * hyphen continues into something that is not a name segment (`--sg-dialog-*`, a comment naming a
 * whole family). Neither can be a declaration — every token the library ships is lowercase and
 * complete — so the exclusions follow from the naming convention rather than from a list somebody
 * has to keep current.
 */
export function scanSourceTokens(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of librarySources().sort()) {
    const text = readFileSync(file, "utf8");
    for (const [name] of text.matchAll(/--sg-[a-z0-9]+(?:-[a-z0-9]+)*(?![a-z0-9-])/g)) {
      const where = relative(REPO_ROOT, file);
      const seen = found.get(name);
      if (seen === undefined) found.set(name, [where]);
      else if (!seen.includes(where)) seen.push(where);
    }
  }
  return found;
}

/**
 * A `var(--sg-name, fallback)` default found anywhere in the library's sources, for a token that
 * has no central declaration in `tokens.css` / `layout.css` at all.
 *
 * Every token this site knows about should be declared centrally, so a host can restyle it by
 * overriding one custom property. A name read only through a scattered `var(..., fallback)` — with
 * no declaration a host's override would ever reach — is itself a gap in the library, tracked in
 * `user-docs-bug-findings/`, not something to paper over by inventing a declaration here. This
 * function only recovers enough to give the row *a* value instead of failing the whole build, and
 * `registryRows()` marks any row it fills this way so the page can say so too.
 */
function varFallbackOf(name: string): string | undefined {
  for (const file of librarySources()) {
    const text = readFileSync(file, "utf8");
    const marker = `var(${name},`;
    const at = text.indexOf(marker);
    if (at === -1) continue;
    let depth = 1;
    let i = at + marker.length;
    let out = "";
    while (i < text.length && depth > 0) {
      const ch = text[i] ?? "";
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      out += ch;
      i += 1;
    }
    const value = out.trim();
    if (value !== "") return value;
  }
  return undefined;
}

/** Every source file of every library package: each `packages/<pkg>/src` and each plugin's `src`. */
function librarySources(): string[] {
  const roots: string[] = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "plugins") continue;
    roots.push(join(PACKAGES, entry.name, "src"));
  }
  // The 15 official plugins sit flat under packages/plugins/<name> — no classification tier.
  for (const plugin of readdirSync(PLUGIN_PACKAGES, { withFileTypes: true })) {
    if (plugin.isDirectory()) roots.push(join(PLUGIN_PACKAGES, plugin.name, "src"));
  }
  return roots.filter(existsSync).flatMap((root) => filesIn(root));
}

/** Every `.ts` / `.css` file under `dir`, recursively, sorted so the output is stable. */
function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesIn(full));
    else if (/\.(ts|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every `--sg-*` declaration in the bundled stylesheet, as name → declared value.
 *
 * Reads both `tokens.css` (the `@property` registrations' `initial-value` — a light-only
 * fallback) and `layout.css` (the one rule that declares every token's real, possibly
 * `light-dark()`, value). `layout.css` wins when a name is declared in both, since it is the value
 * a chart actually paints with; `tokens.css` only fills in for a name that (unusually) has no
 * `layout.css` counterpart. Comments are stripped first, so a commented-out declaration is not
 * one, and `@property` blocks themselves contribute nothing here — their `initial-value` is read
 * separately, in `propertyFallbacks()`.
 */
function declarationsIn(file: string): Map<string, string> {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutAtProperty = css.replace(/@property[^{]*\{[^}]*\}/g, "");
  const out = new Map<string, string>();
  for (const [, name, raw] of withoutAtProperty.matchAll(/(--sg-[\w-]+)\s*:\s*([^;{}]+);/g)) {
    out.set(name ?? "", (raw ?? "").replace(/\s+/g, " ").trim());
  }
  return out;
}

/** The `@property` registrations' `initial-value`, as name → value — the light-only fallback. */
function propertyFallbacks(): Map<string, string> {
  const css = readFileSync(TOKENS_CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const [, name, body] of css.matchAll(/@property\s+(--sg-[\w-]+)\s*\{([^}]*)\}/g)) {
    const value = /initial-value:\s*([^;]+);/.exec(body ?? "")?.[1];
    if (name !== undefined && value !== undefined) out.set(name, value.trim());
  }
  return out;
}

/** The `@property` registrations, as name → declared syntax (`"<color>"` → `color`). */
function registeredSyntax(): Map<string, string> {
  const css = readFileSync(TOKENS_CSS, "utf8");
  const out = new Map<string, string>();
  for (const [, name, syntax] of css.matchAll(/@property\s+(--sg-[\w-]+)\s*\{[^}]*?syntax:\s*"<([a-z-]+)>"/g)) {
    out.set(name ?? "", syntax ?? "");
  }
  return out;
}

/** A value that derives from other tokens rather than carrying one of its own. */
function isDerived(value: string): boolean {
  return /^(calc|clamp|min|max|var)\s*\(.*\)$/.test(value);
}

interface RegistryRow {
  name: string;
  light: string;
  dark: string | null;
  readers: string[];
  note: string;
}

/**
 * Splits a `light-dark(A, B)` value into its two halves, respecting nested parens (`rgba(...)`
 * inside either half). Returns `null` when the value is not a `light-dark()` call — the token is
 * identical in both schemes.
 */
function splitLightDark(value: string): { light: string; dark: string } | null {
  const m = /^light-dark\(([\s\S]*)\)$/.exec(value.trim());
  if (m === null) return null;
  const inner = m[1] ?? "";
  let depth = 0;
  let splitAt = -1;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      splitAt = i;
      break;
    }
  }
  if (splitAt === -1) return null;
  return { light: inner.slice(0, splitAt).trim(), dark: inner.slice(splitAt + 1).trim() };
}

/**
 * There is no separate normative token registry document — the stylesheet itself is the
 * registry, so each row is built straight from what `tokens.css` + `layout.css` declare.
 * `readers` is filled in later, from a scan of every plugin package's own sources
 * (`mentioningPackages`) — the only place "which plugin reads this token" is recorded.
 */
function registryRows(publishedNames: ReadonlySet<string>): RegistryRow[] {
  const declared = new Map<string, string>([...declarationsIn(TOKENS_CSS), ...declarationsIn(LAYOUT_CSS)]);
  const fallbacks = propertyFallbacks();
  // A name registered via @property but never declared in layout.css (none expected today, but
  // the extractor should not silently drop one) still gets a row from its fallback.
  for (const [name, value] of fallbacks) if (!declared.has(name)) declared.set(name, value);

  const rows: RegistryRow[] = [];
  for (const [name, value] of declared) {
    if (isDerived(value)) continue; // these become `derived[]`, not reference rows
    const split = splitLightDark(value);
    rows.push({
      name,
      light: split?.light ?? value,
      dark: split?.dark ?? null,
      readers: [],
      note: "",
    });
  }

  // Names the library reads through `var(..., fallback)` but never declares anywhere: not a name
  // this page should hide (a reader can still meet it in a stylesheet), so it gets a row too, from
  // the fallback found in source — with a note flagging the gap. See
  // user-docs-bug-findings/001-dialog-muted-fg-token-undeclared.html.
  //
  // The renderer's own *published* tokens (`--sg-safe-*`) are excluded here on purpose: they are
  // read the same way (`var(--sg-safe-top, 0px)`, defensively, by every plugin that positions an
  // overlay), but that is by design, not a gap — they have no central declaration because the
  // renderer writes them as an *output* of layout, never an input a host sets. `buildTokens()`
  // accounts for them separately, in `published`.
  for (const [name] of scanSourceTokens()) {
    if (declared.has(name)) continue;
    if (publishedNames.has(name)) continue;
    if (rows.some((row) => row.name === name)) continue;
    const fallback = varFallbackOf(name);
    if (fallback === undefined) continue; // stays unaccounted-for; assertComplete() will name it
    const split = splitLightDark(fallback);
    rows.push({
      name,
      light: split?.light ?? fallback,
      dark: split?.dark ?? null,
      readers: [],
      note: "Not centrally declared — read only through a var() fallback in the plugin that uses it, so a stylesheet override never reaches it. Reported as a library gap; see user-docs-bug-findings.",
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  if (rows.length < 100) throw new Error(`only ${rows.length} declared --sg-* rows found (tokens.css + layout.css)`);
  return rows;
}

/** A string-keyed object literal exported from a theme-internal module, as a Map. */
function exportedRecord(file: string, name: string): Map<string, string> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const out = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      const literal = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isObjectLiteralExpression(literal)) {
        for (const property of literal.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          if (!ts.isStringLiteral(property.name)) continue;
          if (!ts.isStringLiteral(property.initializer) && !ts.isNoSubstitutionTemplateLiteral(property.initializer)) {
            continue;
          }
          out.set(property.name.text, property.initializer.text);
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  if (out.size === 0) throw new Error(`${name} not found (or empty) in ${relative(REPO_ROOT, file)}`);
  return out;
}

/** A string-array export from a theme-internal module. */
function exportedList(file: string, name: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      const literal = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isArrayLiteralExpression(literal)) {
        for (const element of literal.elements) if (ts.isStringLiteral(element)) out.push(element.text);
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  if (out.length === 0) throw new Error(`${name} not found (or empty) in ${relative(REPO_ROOT, file)}`);
  return out;
}

/* ------------------------------------------------------------------ *
 * Classifying
 * ------------------------------------------------------------------ */

/**
 * What kind of value a token holds.
 *
 * The `@property` registration is the authority where there is one — it is the browser's own
 * answer — and the value's shape decides the rest. Fonts are recognised by the `-font` /
 * `-font-family` suffix the registry uses for whole `font` shorthands and family lists, which a
 * host overrides very differently from a colour.
 */
function kindOf(name: string, syntax: string | undefined, light: string): TokenKind {
  if (syntax === "color") return "color";
  if (syntax === "number") return "number";
  if (syntax === "length") return "length";
  if (/-font(-family)?$/.test(name)) return "font";
  if (/^(#|rgb|hsl|color\(|light-dark\(\s*#)/.test(light)) return "color";
  if (/^-?[\d.]+px$/.test(light)) return "length";
  if (/^-?[\d.]+$/.test(light)) return "number";
  return "text";
}

/** The first name segment after the prefix: `--sg-dialog-bg` → `dialog`. */
function family(name: string): string {
  return name.replace(/^--sg-/, "").split("-")[0] ?? "";
}

/** Reading order for the plugin groups, matching the sidebar's. */
const CATEGORY_ORDER = ["basic", "interaction", "scheduling", "resource", "export", "data", "dev", "portfolio"];

interface PluginLike {
  id: string;
  category: string;
}

function pluginIndex(): { names: Set<string>; rank: Map<string, number> } {
  const api = JSON.parse(readFileSync(join(DOCS_ROOT, "src/generated/api.json"), "utf8")) as {
    plugins: PluginLike[];
  };
  const names = new Set<string>();
  const rank = new Map<string, number>();
  const ordered = [...api.plugins].sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.id.localeCompare(b.id),
  );
  ordered.forEach((plugin, index) => {
    const short = plugin.id.replace(/^stargantt\./, "");
    names.add(short);
    rank.set(short, index);
  });
  return { names, rank };
}

/**
 * Which packages mention each token, other than the one that holds the stylesheet.
 *
 * The registry attributes a token to the plugin that *paints* with it, and says "stylesheet only"
 * for the ones a plugin's own scoped CSS consumes through `var()` instead — which leaves the panel,
 * menu and toolbar surfaces attributed to nobody even though most belong to exactly one plugin.
 * Who names a token is the evidence for that, so the grouping uses it in two ways: a token exactly
 * one plugin names is that plugin's, and a name prefix several packages reach for is a surface in
 * its own right.
 *
 * `packages/stargantt` is excluded because it is where the stylesheet lives: it declares every
 * token, so counting it would make every token equally "owned" and say nothing.
 */
function mentioningPackages(scan: ReadonlyMap<string, string[]>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [token, files] of scan) {
    const owners = new Set<string>();
    for (const file of files) {
      // Plugin packages are flat (packages/plugins/<name>/src/...) — no classification tier
      // to skip past.
      const match = /^packages\/(?:plugins\/)?([^/]+)\//.exec(file);
      const owner = match?.[1];
      if (owner !== undefined && owner !== "stargantt") owners.add(owner);
    }
    out.set(token, owners);
  }
  return out;
}

/** The one plugin that names a token, when it is the only package that does. */
function soleOwner(owners: ReadonlySet<string> | undefined, pluginNames: ReadonlySet<string>): string | undefined {
  if (owners === undefined || owners.size !== 1) return undefined;
  const [only] = owners;
  return only !== undefined && pluginNames.has(only) ? only : undefined;
}

/**
 * Which group a token is listed under.
 *
 * There is no external registry to name a token's primary reader (see the header comment), so
 * grouping runs on source evidence alone, two rules in order — each mechanical so that a new
 * token joins a group by existing rather than by being remembered:
 *
 * 1. the name prefix, where that prefix names a surface **more than one** plugin styles —
 *    `--sg-dialog-*` is the dialog surface, and listing its background under one plugin and its
 *    danger colour under another would hide the family from the reader restyling dialogs;
 * 2. the plugin whose sources are the only ones that name it, which is how a panel, a menu or a
 *    toolbar — consumed by a plugin's own scoped CSS rather than painted — reaches its plugin.
 *
 * What no rule claims is the chart's own base surface: the handful every chart paints with,
 * whatever plugins are loaded.
 */
function groupOf(
  row: RegistryRow,
  owners: ReadonlyMap<string, Set<string>>,
  pluginNames: ReadonlySet<string>,
  sharedFamilies: ReadonlySet<string>,
): { id: string; kind: TokenGroup["kind"] } {
  const prefix = family(row.name);
  if (sharedFamilies.has(prefix)) return { id: prefix, kind: "family" };
  const owner = soleOwner(owners.get(row.name), pluginNames);
  if (owner !== undefined) return { id: owner, kind: "plugin" };
  return { id: "base", kind: "base" };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

export function buildTokens(): TokenSnapshot {
  const { names: pluginNames, rank } = pluginIndex();
  const safeArea = [...new Set(readFileSync(SAFE_AREA, "utf8").match(/--sg-safe-[a-z]+/g) ?? [])].sort();
  if (safeArea.length === 0) throw new Error("no --sg-safe-* properties found in the renderer's safe-area module");
  const rows = registryRows(new Set(safeArea));
  const declared = new Map<string, string>([...declarationsIn(TOKENS_CSS), ...declarationsIn(LAYOUT_CSS)]);
  const syntax = registeredSyntax();
  const forcedColors = exportedRecord(join(THEME_INTERNAL, "forced-colors.ts"), "FORCED_COLOR_TOKENS");
  const nonColorCanvas = new Set(exportedList(join(THEME_INTERNAL, "registry.ts"), "NON_COLOR_CANVAS_TOKENS"));
  const retiredMap = exportedRecord(join(THEME_INTERNAL, "registry.ts"), "RETIRED_TOKENS");

  const scan = scanSourceTokens();
  const owners = mentioningPackages(scan);

  // Which plugins' own sources mention each token — the only reader attribution there is (see
  // the header comment). Sorted by the sidebar's plugin order so the field is stable and scannable.
  for (const row of rows) {
    row.readers = [...(owners.get(row.name) ?? [])]
      .filter((name) => pluginNames.has(name))
      .sort((a, b) => (rank.get(a) ?? 1_000) - (rank.get(b) ?? 1_000));
  }

  // A prefix earns a group of its own when more than one package styles it. A prefix one plugin
  // owns outright is that plugin's, and a prefix nobody outside the stylesheet names is part of
  // the base surface — neither is a family.
  const familyOwners = new Map<string, Set<string>>();
  const familyCount = new Map<string, number>();
  for (const row of rows) {
    const prefix = family(row.name);
    familyCount.set(prefix, (familyCount.get(prefix) ?? 0) + 1);
    const set = familyOwners.get(prefix) ?? new Set<string>();
    for (const owner of owners.get(row.name) ?? []) set.add(owner);
    familyOwners.set(prefix, set);
  }
  const sharedFamilies = new Set(
    [...familyOwners]
      .filter(([prefix, set]) => set.size >= 2 && (familyCount.get(prefix) ?? 0) >= 2)
      .map(([prefix]) => prefix),
  );

  const tokens: TokenDoc[] = rows.map((row) => {
    const group = groupOf(row, owners, pluginNames, sharedFamilies);
    return {
      name: row.name,
      group: group.id,
      kind: kindOf(row.name, syntax.get(row.name), row.light),
      light: row.light,
      dark: row.dark,
      canvasRead: forcedColors.has(row.name) || nonColorCanvas.has(row.name),
      forcedColor: forcedColors.get(row.name) ?? null,
      readers: row.readers,
      note: row.note,
    };
  });

  const groupKinds = new Map<string, TokenGroup["kind"]>();
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const group = groupOf(row, owners, pluginNames, sharedFamilies);
    groupKinds.set(group.id, group.kind);
    const list = grouped.get(group.id);
    if (list === undefined) grouped.set(group.id, [row.name]);
    else list.push(row.name);
  }

  // Base first — it is what every chart paints with — then the plugin groups in the sidebar's
  // order, then the stylesheet families alphabetically.
  const groups: TokenGroup[] = [...grouped]
    .map(([id, list]) => ({ id, kind: groupKinds.get(id) ?? "family", tokens: list }))
    .sort((a, b) => groupSort(a, rank) - groupSort(b, rank) || a.id.localeCompare(b.id));

  const derived: DerivedToken[] = [...declared]
    .filter(([, value]) => isDerived(value))
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const snapshot: TokenSnapshot = {
    schemaVersion: 1,
    groups,
    tokens,
    derived,
    published: safeArea.map((name) => ({ name })),
    retired: [...retiredMap]
      .map(([name, advice]) => ({ name, advice: advice.replace(/\s+/g, " ").trim() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };

  assertComplete(snapshot);
  return snapshot;
}

/** Every `--sg-*` name this snapshot accounts for, whatever its classification. */
export function documentedNames(snapshot: TokenSnapshot): Set<string> {
  return new Set([
    ...snapshot.tokens.map((token) => token.name),
    ...snapshot.derived.map((token) => token.name),
    ...snapshot.published.map((token) => token.name),
    ...snapshot.retired.map((token) => token.name),
  ]);
}

/**
 * Stops the extraction on any token the library uses and this snapshot does not carry.
 *
 * This is the whole point of the file: the page's promise is that a name absent from it is a name
 * the library does not have. Writing a snapshot with a hole in it would turn that promise into a
 * lie that nothing downstream can detect, so the generator refuses rather than the test catching
 * it later — though the test checks the same thing, from the committed artifact.
 */
function assertComplete(snapshot: TokenSnapshot): void {
  const known = documentedNames(snapshot);
  const missing = [...scanSourceTokens()]
    .filter(([name]) => !known.has(name))
    .map(([name, files]) => `${name} (${files.slice(0, 3).join(", ")})`);
  if (missing.length > 0) {
    throw new Error(
      `these tokens appear in the library sources but in no source this extractor reads:\n  ${missing.join("\n  ")}\n` +
        "A new token belongs in tokens.css / layout.css (the stylesheet is the registry) before it can be documented.",
    );
  }
}

function groupSort(group: TokenGroup, rank: ReadonlyMap<string, number>): number {
  if (group.kind === "base") return -1;
  if (group.kind === "plugin") return rank.get(group.id) ?? 1_000;
  return 10_000;
}

export const serialize = (snapshot: TokenSnapshot): string => `${JSON.stringify(snapshot, null, 2)}\n`;

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const snapshot = buildTokens();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, serialize(snapshot));
  const canvas = snapshot.tokens.filter((token) => token.canvasRead).length;
  process.stdout.write(
    `tokens.json: ${snapshot.tokens.length} tokens in ${snapshot.groups.length} groups ` +
      `(${canvas} canvas-read), ${snapshot.derived.length} derived, ${snapshot.published.length} published, ` +
      `${snapshot.retired.length} retired\n`,
  );
}
