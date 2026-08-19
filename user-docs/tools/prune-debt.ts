/**
 * Removes plugins from `docs-debt.json` once they have a content module.
 *
 * Only ever removes. Adding a plugin to the debt list stays a manual act, because "this is not
 * documented and we are choosing to ship anyway" is a decision, and a script that could make it
 * silently would turn the list into a place where holes accumulate instead of a place where they
 * are counted (docs-policy.md D-04).
 *
 * Run by the coordinating maintainer between batches, never by the agents writing pages: several agents
 * editing one JSON file concurrently loses entries, and losing an entry here means losing the
 * record of a hole.
 *
 * Run: node tools/prune-debt.ts
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(HERE, "..");
const DEBT = join(DOCS_ROOT, "docs-debt.json");
const CONTENT = join(DOCS_ROOT, "src/content/plugins");

interface Debt {
  $comment: string[];
  undocumented: string[];
}

/** Plugin ids that now have a module, read from the files rather than from any index. */
function documentedIds(): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(CONTENT)) return ids;
  for (const category of readdirSync(CONTENT, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    for (const file of readdirSync(join(CONTENT, category.name))) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(CONTENT, category.name, file), "utf8");
      // Anchored on the doc declaration, not on the first `id:` in the file. Modules that define a
      // local dataset before the doc — several plugins need tasks the shared sample does not have —
      // put a task's id first, and matching that silently left those plugins on the debt list while
      // reporting success.
      const id = /:\s*PluginDoc\s*=\s*\{\s*id:\s*"([^"]+)"/.exec(source)?.[1];
      if (id) ids.add(id);
      else process.stderr.write(`could not read a plugin id from ${category.name}/${file}\n`);
    }
  }
  return ids;
}

const debt = JSON.parse(readFileSync(DEBT, "utf8")) as Debt;
const documented = documentedIds();
const remaining = debt.undocumented.filter((id) => !documented.has(id));
const cleared = debt.undocumented.filter((id) => documented.has(id));

writeFileSync(DEBT, `${JSON.stringify({ ...debt, undocumented: remaining }, null, 2)}\n`);

process.stdout.write(
  cleared.length === 0
    ? `docs-debt.json unchanged — ${remaining.length} plugins still undocumented\n`
    : `cleared ${cleared.length}: ${cleared.join(", ")}\n${remaining.length} plugins still undocumented\n`,
);
if (remaining.length === 0) {
  process.stdout.write("the debt list is empty — delete docs-debt.json and the tests that read it\n");
}
