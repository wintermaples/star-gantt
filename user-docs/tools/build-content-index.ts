/**
 * Builds the two artifacts derived from the content modules.
 *
 * `src/generated/content-manifest.json` — the identity of every page: each guide's and chapter's
 * slug and title, and which module file backs each plugin id. It exists so the sidebar, the router
 * and the route list can be built **without importing a single content module**: the modules are a
 * megabyte of prose, and eagerly importing all of them to read 75 titles is what made the site ship
 * every page to every reader.
 *
 * `src/generated/search-index.json` — everything the site's search box can find.
 *
 * Why this is generated rather than derived in the browser: the index has to cover every page, and
 * deriving it at runtime would mean loading every content module before the reader has typed
 * anything, which is exactly the cost the lazy page loading exists to avoid. A build-time index is
 * a small artifact the search box fetches once, on first use.
 *
 * Why it imports the content modules instead of parsing them: they are plain data — a `PluginDoc`
 * is an object literal — so importing them gives the real titles and summaries rather than an
 * approximation of them, and an index built from a parse could silently disagree with the page it
 * points at. The one thing Node needs help with is Vite's extensionless relative imports, which the
 * resolve hook below supplies; everything after that is ordinary `await import()`.
 *
 * What is indexed: identifiers and one-line summaries — plugin ids, option names, service / event /
 * command / extension-point keys, guide and chapter titles, recipe titles. Deliberately **not** the
 * body prose: full text would multiply the index size for hits that land the reader in the middle
 * of a paragraph they then have to read anyway, and the titles are what a reader searching
 * documentation actually knows the name of.
 *
 * Both outputs are committed, and `test/coverage.test.ts` re-runs this and fails on any difference
 * — the same rule `api.json` follows (docs-policy.md D-05).
 *
 * Run: node tools/build-content-index.ts
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withoutMarks } from "../src/lib/inline.ts";

/* ------------------------------------------------------------------ *
 * Module resolution — Vite's extensionless relative imports, for Node.
 * ------------------------------------------------------------------ */

/**
 * Only when run as a script. Vitest imports this module for its freshness check and resolves those
 * same specifiers itself, so installing a global loader hook there would be a side effect with no
 * purpose.
 */
const RUN_AS_SCRIPT =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (RUN_AS_SCRIPT) {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith(".") && context.parentURL !== undefined) {
        const asWritten = new URL(specifier, context.parentURL);
        if (!existsSync(fileURLToPath(asWritten))) {
          for (const suffix of [".ts", ".tsx", "/index.ts"]) {
            const candidate = new URL(specifier + suffix, context.parentURL);
            if (existsSync(fileURLToPath(candidate)))
              return next(specifier + suffix, context);
          }
        }
      }
      return next(specifier, context);
    },
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(HERE, "..");
const CONTENT = join(DOCS_ROOT, "src/content");
const SEARCH_OUT = join(DOCS_ROOT, "src/generated/search-index.json");
const MANIFEST_OUT = join(DOCS_ROOT, "src/generated/content-manifest.json");

/* ------------------------------------------------------------------ *
 * Shapes — mirrored by `src/lib/search.ts`, which scores them.
 * ------------------------------------------------------------------ */

/** Which kind of thing a hit is. Also its tie-break order: earlier wins an equal score. */
export const KINDS = [
  "guide",
  "core",
  "plugin",
  "option",
  "service",
  "event",
  "command",
  "point",
  "recipe",
  "token",
] as const;

export type SearchKind = (typeof KINDS)[number];

export interface SearchEntry {
  kind: SearchKind;
  /** The identifier a reader would type: an option name, a plugin's short name, a title. */
  title: string;
  /** Where it lives, shown beside the title — `tree-grid · config`. */
  context: string;
  /** The route, including any query the page reads to select a tab or scroll to a section. */
  path: string;
  /** One line. Scored at low weight and shown under the title. */
  text: string;
  /** Extra tokens that are worth matching but not worth showing — a plugin's full id, its package. */
  keywords?: string;
}

/* ------------------------------------------------------------------ *
 * Reading the content
 * ------------------------------------------------------------------ */

interface ApiMemberLike {
  key: string;
  type: string;
  doc: string;
}

interface ApiPluginLike {
  id: string;
  package: string;
  category: string;
  config: { name: string; type: string; doc: string }[];
  services: ApiMemberLike[];
  events: ApiMemberLike[];
  commands: ApiMemberLike[];
  extensionPoints: ApiMemberLike[];
}

const api = JSON.parse(
  readFileSync(join(DOCS_ROOT, "src/generated/api.json"), "utf8"),
) as {
  plugins: ApiPluginLike[];
};

const tokens = JSON.parse(readFileSync(join(DOCS_ROOT, "src/generated/tokens.json"), "utf8")) as {
  tokens: { name: string; group: string; note: string; readers: string[] }[];
};

const short = (id: string): string => id.replace(/^stargantt\./, "");

/** One line of a longer text: whitespace collapsed, cut at the first sentence end, then capped. */
function oneLine(text: string, cap = 180): string {
  const flat = withoutMarks(text).replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  const stop = flat.search(/\.\s/);
  const sentence = stop > 30 ? flat.slice(0, stop + 1) : flat;
  return sentence.length <= cap ? sentence : `${sentence.slice(0, cap - 1).trimEnd()}…`;
}

/** Every `.ts` under `dir`, recursively, sorted — the same discovery `registry.ts` does with glob. */
function modulesIn(dir: string): string[] {
  const out: string[] = [];
  const listing = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of listing) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...modulesIn(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** A content module's default export, with the specifier `registry.ts`'s glob knows it by. */
interface Loaded<T> {
  doc: T;
  /** Relative to `src/content/`, with the leading `./` Vite's `import.meta.glob` keys carry. */
  module: string;
}

async function loadDefaults<T>(dir: string): Promise<Loaded<T>[]> {
  const docs: Loaded<T>[] = [];
  for (const file of modulesIn(dir)) {
    const module = (await import(pathToFileURL(file).href)) as { default?: T };
    if (module.default !== undefined) {
      docs.push({ doc: module.default, module: `./${relative(CONTENT, file).split(sep).join("/")}` });
    }
  }
  return docs;
}

interface GuideLike {
  slug: string;
  title: string;
  lede: string;
}

interface PluginDocLike {
  id: string;
  summary: string;
  recipes: { title: string; intent: string }[];
}

/* ------------------------------------------------------------------ *
 * Building the entries
 * ------------------------------------------------------------------ */

const MEMBER_KINDS = [
  { field: "services", kind: "service", tab: "services", label: "service" },
  { field: "events", kind: "event", tab: "events", label: "event" },
  { field: "commands", kind: "command", tab: "commands", label: "command" },
  { field: "extensionPoints", kind: "point", tab: "points", label: "extension point" },
] as const;

/** The whole index, in the committed order. Exported so the test can re-derive and compare it. */
export async function buildIndex(): Promise<SearchEntry[]> {
  const entries: SearchEntry[] = [];

  const guides = await loadDefaults<GuideLike>(join(CONTENT, "guides"));
  for (const { doc: guide } of guides) {
    entries.push({
      kind: "guide",
      title: guide.title,
      context: "guide",
      path: `/guides/${guide.slug}`,
      text: oneLine(guide.lede),
      keywords: guide.slug.replace(/-/g, " "),
    });
  }

  const chapters = await loadDefaults<GuideLike>(join(CONTENT, "core"));
  for (const { doc: chapter } of chapters) {
    entries.push({
      kind: "core",
      title: chapter.title,
      context: "core concept",
      path: `/core/${chapter.slug}`,
      text: oneLine(chapter.lede),
      keywords: chapter.slug.replace(/-/g, " "),
    });
  }

  // Token names are the one identifier a reader arrives with that belongs to no plugin page: the
  // stylesheet they are debugging names `--sg-bar-fill`, not `task-bars`. Each entry carries the
  // query the token page reads to scroll that row into view.
  const tokensDoc = (await import(pathToFileURL(join(CONTENT, "tokens.ts")).href)) as {
    default: { groups: { id: string; title: string }[] };
  };
  const groupTitles = new Map(tokensDoc.default.groups.map((group) => [group.id, group.title]));
  for (const token of tokens.tokens) {
    entries.push({
      kind: "token",
      title: token.name,
      context: `${groupTitles.get(token.group) ?? token.group} · css token`,
      path: `/tokens?t=${token.name}`,
      text: oneLine(token.note),
      keywords: `css custom property variable ${token.readers.join(" ")}`,
    });
  }

  const pluginDocs = new Map<string, PluginDocLike>();
  for (const { doc } of await loadDefaults<PluginDocLike>(join(CONTENT, "plugins"))) {
    pluginDocs.set(doc.id, doc);
  }

  for (const plugin of api.plugins) {
    const name = short(plugin.id);
    const doc = pluginDocs.get(plugin.id);

    entries.push({
      kind: "plugin",
      title: name,
      context: `${plugin.category} plugin`,
      path: `/reference/${name}`,
      text: oneLine(doc?.summary ?? ""),
      keywords: `${plugin.id} ${plugin.package}`,
    });

    for (const option of plugin.config) {
      entries.push({
        kind: "option",
        title: option.name,
        context: `${name} · config`,
        path: `/reference/${name}/config?p=${option.name}`,
        text: oneLine(option.doc),
        keywords: option.type,
      });
    }

    for (const { field, kind, tab, label } of MEMBER_KINDS) {
      for (const member of plugin[field]) {
        entries.push({
          kind,
          title: member.key,
          context: `${name} · ${label}`,
          path: `/reference/${name}?tab=${tab}`,
          text: oneLine(member.doc),
          keywords: member.type,
        });
      }
    }

    for (const recipe of doc?.recipes ?? []) {
      entries.push({
        kind: "recipe",
        title: recipe.title,
        context: `${name} · recipe`,
        path: `/reference/${name}?tab=recipes`,
        text: oneLine(recipe.intent),
      });
    }
  }

  // Stable order, so a regenerated index diffs only where the content actually changed.
  entries.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path) || a.title.localeCompare(b.title),
  );
  return entries;
}

export function serialize(list: readonly SearchEntry[]): string {
  return `${JSON.stringify({ entries: list }, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * The manifest: page identity without page content
 * ------------------------------------------------------------------ */

export interface ManifestPage {
  slug: string;
  title: string;
  /** The `import.meta.glob` key of the module that holds this page's content. */
  module: string;
}

export interface ManifestPlugin {
  id: string;
  module: string;
}

export interface ContentManifest {
  guides: ManifestPage[];
  core: ManifestPage[];
  plugins: ManifestPlugin[];
}

/** Slug, title and module path for every page — everything the nav and the router need. */
export async function buildManifest(): Promise<ContentManifest> {
  const pages = async (dir: string): Promise<ManifestPage[]> =>
    (await loadDefaults<GuideLike>(join(CONTENT, dir))).map(({ doc, module }) => ({
      slug: doc.slug,
      title: doc.title,
      module,
    }));
  return {
    guides: await pages("guides"),
    core: await pages("core"),
    plugins: (await loadDefaults<PluginDocLike>(join(CONTENT, "plugins")))
      .map(({ doc, module }) => ({ id: doc.id, module }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function serializeManifest(manifest: ContentManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * Writing them out
 * ------------------------------------------------------------------ */

if (RUN_AS_SCRIPT) {
  const manifest = await buildManifest();
  writeFileSync(MANIFEST_OUT, serializeManifest(manifest));
  console.log(
    `content-manifest.json: ${manifest.guides.length} guides, ${manifest.core.length} chapters, ` +
      `${manifest.plugins.length} plugin modules`,
  );

  const built = await buildIndex();
  const json = serialize(built);
  writeFileSync(SEARCH_OUT, json);

  const byKind = new Map<string, number>();
  for (const entry of built) byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
  const summary = KINDS.filter((k) => byKind.has(k))
    .map((k) => `${byKind.get(k)} ${k}`)
    .join(", ");
  console.log(
    `search-index.json: ${built.length} entries (${summary}), ${(json.length / 1024).toFixed(1)} kB`,
  );
}
