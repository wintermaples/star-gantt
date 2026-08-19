/**
 * Extracts the documented API surface of every StarGantt package straight from its TypeScript
 * source, and writes it to `src/generated/api.json`.
 *
 * Why the source and not the emitted declarations: the sources carry the TSDoc, the literal
 * `dependsOn` list, the plugin id constant and the `declare module "@stargantt/core"` augmentations
 * in one place, and they do not require the library to have been built.
 *
 * Why the AST and not the type checker: everything here is syntax — an interface's property names,
 * the text of their type annotations, the keys inside a declaration-merging block. Type resolution
 * would cost a full program build across the plugin packages and would inline the very type aliases
 * the docs want to name.
 *
 * The output is committed. `test/api-json.test.ts` re-runs this and fails on any difference, so an
 * API change that the documentation has not caught up with shows as a diff rather than as silence.
 *
 * Run: node tools/extract-api.ts        (Node strips the types; no build step)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(HERE, "..");
const REPO_ROOT = join(DOCS_ROOT, "..");
const PACKAGES = join(REPO_ROOT, "packages");
const PLUGINS = join(PACKAGES, "plugins");
const SPECS = join(REPO_ROOT, "docs/specs");
const OUT = join(DOCS_ROOT, "src/generated/api.json");

/**
 * The 15 official plugins sit flat under `packages/plugins/<name>` (no classification
 * subfolders — CLAUDE.md ch.1 is explicit about this). A category is still useful for grouping
 * the sidebar and the CSS token page, so this site groups them into an eight-category taxonomy,
 * assigned by hand here instead of read off the directory tree.
 */
const PLUGIN_CATEGORY: Record<string, string> = {
  "data-store": "basic",
  view: "basic",
  "tree-grid": "basic",
  "task-bars": "basic",
  interaction: "interaction",
  "undo-redo": "interaction",
  a11y: "interaction",
  scheduling: "scheduling",
  tracking: "scheduling",
  resource: "resource",
  export: "export",
  "data-sync": "data",
  portfolio: "portfolio",
  i18n: "dev",
  "perf-tools": "dev",
};

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export interface ApiMember {
  key: string;
  type: string;
  doc: string;
}

export interface ApiProperty {
  name: string;
  type: string;
  optional: boolean;
  doc: string;
}

export interface ApiPlugin {
  id: string;
  package: string;
  category: string;
  dir: string;
  factory: string | null;
  configType: string | null;
  config: ApiProperty[];
  dependsOn: string[];
  services: ApiMember[];
  events: ApiMember[];
  commands: ApiMember[];
  extensionPoints: ApiMember[];
  inPresetStandard: boolean;
  contract: string | null;
}

export interface ApiSnapshot {
  /** Bumped by hand when the shape of this file changes, so a stale checkout fails loudly. */
  schemaVersion: number;
  core: { exports: string[]; interfaces: ApiProperty[] };
  plugins: ApiPlugin[];
}

/* ------------------------------------------------------------------ *
 * Syntax helpers
 * ------------------------------------------------------------------ */

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
}

/** The TSDoc attached to a node, with the comment markers and leading asterisks removed. */
function docOf(node: ts.Node, source: ts.SourceFile): string {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [];
  const blocks = ranges
    .filter((r) => source.text.slice(r.pos, r.pos + 3) === "/**")
    .map((r) => source.text.slice(r.pos, r.end));
  const last = blocks.at(-1);
  if (!last) return "";
  return last
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, "").trimEnd())
    .join("\n")
    .trim();
}

/** Re-prints a type annotation from the AST: no comments, standard spacing, four-space indents. */
const PRINTER = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** Where a printed type stops being read as one line on a reference page. */
const ONE_LINE_LIMIT = 80;

/**
 * A type annotation as the page shows it.
 *
 * Taken from the printer rather than from the source text, which flattening to a single line used
 * to mangle: an object type's members ran together, and any TSDoc written *inside* the type came
 * along as a `/** … *\/` run in the middle of the signature. The printer drops those comments (each
 * documented member's own description is extracted separately) and breaks members onto their own
 * lines, so what lands in `api.json` is a shape a reader can scan.
 *
 * Short types stay on one line: a two-member object read perfectly well before, and turning every
 * one of them into three lines would cost more than it explains.
 */
function typeText(node: ts.TypeNode | undefined, source: ts.SourceFile): string {
  if (!node) return "unknown";
  const printed = PRINTER.printNode(ts.EmitHint.Unspecified, node, source);
  const oneLine = printed.replace(/\s*\n\s*/g, " ").trim();
  if (oneLine.length <= ONE_LINE_LIMIT) return oneLine;
  // The printer indents in fours; the site's code blocks are two-space, like every listing a
  // reader copies out of the guides.
  return printed
    .split("\n")
    .map((line) => {
      const indent = line.length - line.trimStart().length;
      return " ".repeat(indent / 2) + line.trimStart();
    })
    .join("\n")
    .trimEnd();
}

/** Every `.ts` file under a directory, recursively. */
function sourceFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesIn(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Finds a named interface or object type alias anywhere in a package.
 *
 * Several plugins declare their config in a sibling module (`./types`, `./internal/config`) and
 * re-export the type from `index.ts`. Looking only at `index.ts` reported those plugins as having
 * no options at all — a silent hole in the documentation exactly where the options are.
 */
function findTypeDecl(
  files: string[],
  name: string,
): { members: readonly ts.TypeElement[]; source: ts.SourceFile } | undefined {
  for (const file of files) {
    const source = parse(file);
    let hit: { members: readonly ts.TypeElement[]; source: ts.SourceFile } | undefined;
    source.forEachChild((node) => {
      if (hit) return;
      if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
        hit = { members: node.members, source };
      } else if (
        ts.isTypeAliasDeclaration(node) &&
        node.name.text === name &&
        ts.isTypeLiteralNode(node.type)
      ) {
        hit = { members: node.type.members, source };
      }
    });
    if (hit) return hit;
  }
  return undefined;
}

function propertiesOf(members: readonly ts.TypeElement[], source: ts.SourceFile): ApiProperty[] {
  const out: ApiProperty[] = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
      ? member.name.text
      : member.name.getText(source);
    out.push({
      name,
      type: typeText(member.type, source),
      optional: member.questionToken !== undefined,
      doc: docOf(member, source),
    });
  }
  return out;
}

/**
 * Members of one `interface X { … }` inside a `declare module "@stargantt/core"` block, across
 * every file of the package — a plugin may split its augmentations the same way it splits its
 * types.
 */
function augmentations(files: string[], interfaceName: string): ApiMember[] {
  const out: ApiMember[] = [];
  for (const file of files) out.push(...augmentation(parse(file), interfaceName));
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m.key) ? false : (seen.add(m.key), true)));
}

/** Members of one `interface X { … }` inside a `declare module "@stargantt/core"` block. */
function augmentation(source: ts.SourceFile, interfaceName: string): ApiMember[] {
  const out: ApiMember[] = [];
  source.forEachChild((node) => {
    if (!ts.isModuleDeclaration(node) || !ts.isStringLiteral(node.name)) return;
    if (node.name.text !== "@stargantt/core") return;
    const body = node.body;
    if (!body || !ts.isModuleBlock(body)) return;
    for (const statement of body.statements) {
      if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== interfaceName) continue;
      for (const member of statement.members) {
        if (!ts.isPropertySignature(member) || !member.name) continue;
        const key = ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(source);
        out.push({ key, type: typeText(member.type, source), doc: docOf(member, source) });
      }
    }
  });
  return out;
}

/** The plugin id: the `PLUGIN_ID` constant, or the `id:` literal inside `definePlugin`. */
function pluginIdOf(source: ts.SourceFile): string | null {
  let fromConst: string | null = null;
  let fromMeta: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "PLUGIN_ID" &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      fromConst ??= node.initializer.text;
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "id" && ts.isStringLiteral(node.initializer)) {
      fromMeta ??= node.initializer.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return fromConst ?? fromMeta;
}

/** The literal `dependsOn: [...]` array passed to `definePlugin`. */
function dependsOnOf(source: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "dependsOn" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (ts.isStringLiteral(element)) out.push(element.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(out)];
}

/**
 * The exported plugin factory and the config interface it takes.
 *
 * A factory is an exported function whose return type mentions `Plugin<`. Its first parameter's
 * type names the config interface — which is how a plugin with no options (no parameter) ends up
 * with a null config type rather than an invented empty one.
 */
function factoryOf(source: ts.SourceFile): { factory: string | null; configType: string | null } {
  let factory: string | null = null;
  let configType: string | null = null;
  source.forEachChild((node) => {
    if (!ts.isFunctionDeclaration(node) || !node.name) return;
    const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return;
    const returns = node.type ? node.type.getText(source) : "";
    if (!returns.includes("Plugin<")) return;
    if (factory) return; // first exported factory wins; packages export exactly one
    factory = node.name.text;
    const param = node.parameters[0];
    const paramType = param?.type ? param.type.getText(source) : "";
    const named = /([A-Za-z_$][\w$]*Config)\b/.exec(paramType);
    configType = named?.[1] ?? null;
  });
  return { factory, configType };
}

/* ------------------------------------------------------------------ *
 * Walk
 * ------------------------------------------------------------------ */

function pluginDirs(): Array<{ category: string; name: string; dir: string }> {
  const out: Array<{ category: string; name: string; dir: string }> = [];
  for (const plugin of readdirSync(PLUGINS, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const dir = join(PLUGINS, plugin.name);
    if (!existsSync(join(dir, "src/index.ts"))) continue;
    const category = PLUGIN_CATEGORY[plugin.name];
    if (category === undefined) {
      throw new Error(`packages/plugins/${plugin.name} has no entry in PLUGIN_CATEGORY — add one`);
    }
    out.push({ category, name: plugin.name, dir });
  }
  return out.sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name));
}

/**
 * Which plugin packages `presetStandard()` composes.
 *
 * The preset names its members as imported factories rather than as id strings, so membership is
 * read from its value imports — matched on the package name, which is a fact, rather than on an id
 * guessed from the package name, which would silently mismatch for any plugin whose id does not
 * follow from its package.
 */
function presetPackages(): Set<string> {
  const source = parse(join(PACKAGES, "preset-standard/src/index.ts"));
  const packages = new Set<string>();
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    if (node.importClause?.isTypeOnly) return;
    const spec = node.moduleSpecifier.text;
    if (spec.startsWith("@stargantt/plugin-")) packages.add(spec);
  });
  return packages;
}

function extractPlugin(entry: { category: string; name: string; dir: string }, presetPkgs: Set<string>): ApiPlugin {
  const file = join(entry.dir, "src/index.ts");
  const source = parse(file);
  const pkg = JSON.parse(readFileSync(join(entry.dir, "package.json"), "utf8")) as { name: string };
  const { factory, configType } = factoryOf(source);
  // index.ts first, so a config declared there wins over a same-named internal type.
  const files = [file, ...sourceFilesIn(join(entry.dir, "src")).filter((f) => f !== file)];
  const configDecl = configType ? findTypeDecl(files, configType) : undefined;
  const id = pluginIdOf(source) ?? `stargantt.${entry.name}`;
  const contract = join(SPECS, "plugins", `${entry.name}.md`);

  return {
    id,
    package: pkg.name,
    category: entry.category,
    dir: relative(REPO_ROOT, entry.dir),
    factory,
    configType,
    config: configDecl ? propertiesOf(configDecl.members, configDecl.source) : [],
    dependsOn: dependsOnOf(source),
    services: augmentations(files, "Services"),
    events: augmentations(files, "Events"),
    commands: augmentations(files, "Commands"),
    extensionPoints: augmentations(files, "ExtensionPoints"),
    inPresetStandard: presetPkgs.has(pkg.name),
    contract: existsSync(contract) ? relative(REPO_ROOT, contract) : null,
  };
}

function extractCore(): ApiSnapshot["core"] {
  const file = join(PACKAGES, "core/src/index.ts");
  const source = parse(file);
  const exports: string[] = [];
  const interfaces: ApiProperty[] = [];
  source.forEachChild((node) => {
    const exported = ts.canHaveModifiers(node)
      ? ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (!exported) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node)) {
      const name = node.name?.text;
      if (!name) return;
      exports.push(name);
      interfaces.push({ name, type: ts.isInterfaceDeclaration(node) ? "interface" : ts.isTypeAliasDeclaration(node) ? "type" : "function", optional: false, doc: docOf(node, source) });
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          exports.push(decl.name.text);
          interfaces.push({ name: decl.name.text, type: "const", optional: false, doc: docOf(node, source) });
        }
      }
    }
  });
  return { exports: exports.sort(), interfaces };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

export function buildSnapshot(): ApiSnapshot {
  const preset = presetPackages();
  return {
    schemaVersion: 1,
    core: extractCore(),
    plugins: pluginDirs().map((entry) => extractPlugin(entry, preset)),
  };
}

export const serialize = (snapshot: ApiSnapshot): string => `${JSON.stringify(snapshot, null, 2)}\n`;

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const snapshot = buildSnapshot();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, serialize(snapshot));
  const withConfig = snapshot.plugins.filter((p) => p.config.length > 0).length;
  const options = snapshot.plugins.reduce((n, p) => n + p.config.length, 0);
  process.stdout.write(
    `api.json: ${snapshot.plugins.length} plugins, ${withConfig} with options, ${options} options total, ` +
      `${snapshot.core.exports.length} core exports\n`,
  );
  // Surface plugins the walk could not read, rather than letting them silently document as empty.
  const suspicious = snapshot.plugins.filter((p) => !p.factory && p.config.length === 0);
  if (suspicious.length > 0) {
    process.stdout.write(`no factory found for: ${suspicious.map((p) => p.id).join(", ")}\n`);
  }
}
