# StarGantt user documentation — ruling ledger (D-nn)

Decisions about the documentation **site**: what it must cover, how it is generated, and what the
tests refuse to let through. Numbering is continuous and never reused; a retired ruling is revised
in place and, if deleted, its number is recorded as a gap at the top of this file.

This ledger is **not** the library's public-API contract corpus; this one is about a website. Keeping
them apart is itself D-01.

Gaps in numbering: none.

---

## D-01 — Documentation rulings live here, not in the A-nn ledger

**Question.** The repository's loop convention says every settled ambiguity is recorded as an A-nn
clause in the library's public-API contract corpus. Do decisions about the docs site go there?

**Ruling.** No. They go here, numbered D-nn.

**Why.** The contract corpus is the single source of truth for the public API (SGC-532). A site's
information architecture, its test policy and its authoring rules are not public API, and mixing
them into that ledger would make "read the contract" stop meaning "read what the library
guarantees". A separate number space also means neither ledger's numbering is disturbed by the
other's churn.

---

## D-02 — The docs site stays outside the library's pnpm workspace

**Ruling.** `user-docs/` has its own `pnpm-workspace.yaml`, its own lockfile and its own
`node_modules`. It is not matched by the root workspace patterns.

**Why.** CLAUDE.md forbids third-party runtime dependencies in the library. The site needs React,
CodeMirror, Vite and sucrase. If the site were a workspace member, those would appear as
`dependencies` of a `@stargantt/*` package and any audit of that constraint — human or scripted —
would have to carve out an exception. Physical separation removes the question instead of
answering it.

**Cost, accepted.** `pnpm -r` at the root does not reach the site, so the root `package.json`
carries explicit `docs:*`, `test:docs*` and `typecheck:docs` scripts. Forgetting to run them is the
failure mode this trades for.

---

## D-03 — Charts on the site are the shipped bundle, mounted through the public entry

**Ruling.** Every embedded chart is `create()` from `packages/stargantt/dist/stargantt.js` with
`presetStandard()` plus, for opt-in plugins, the same factories a reader would call. No
documentation-only API, no deep import into `packages/*/src`, no patched build.

**Why.** A documentation example that needs a private hook is not documentation of the library; it
is documentation of a fork. The rule also makes the site an integration test of the public surface:
if a demo cannot be expressed with the public API, that is a finding about the API.

**Consequence.** The site reads a **built** artifact, so the library must be built before running
the site or its e2e suite — the same stale-artifact hazard the library's own e2e suite has, and it
is called out in `README.md`, `CLAUDE.md` and the launch configuration.

---

## D-04 — Missing pages are enumerated, not hidden

**Ruling.** A plugin with no content module still gets a sidebar row, marked `todo`, and a page that
says it is not documented yet. Every such plugin is listed in `docs-debt.json`. The coverage test
fails if an undocumented plugin is missing from that list, and fails again if a listed plugin has
since been documented.

**Why.** The failure mode of large documentation is not a wrong page, it is an absent one that
nobody can see is absent. A navigation tree built only from what exists cannot distinguish
"complete" from "we stopped". Enumerating the debt makes the gap countable, reviewable, and
monotonically shrinking; the stale-entry check is what stops the list from becoming a place to
park things.

**Retirement.** When `undocumented` is empty, delete the file. An empty debt list is not worth
keeping — and it was: the list is gone, and what replaced it is the stricter rule that a plugin
without a page fails outright, with nothing to add yourself to.

---

## D-05 — Mechanical facts are generated from the TypeScript sources

**Ruling.** Plugin ids, `dependsOn` lists, config option names and types, and the keys and
signatures of services / events / commands / extension points are extracted by
`tools/extract-api.ts` into `src/generated/api.json`. The file is committed. `test/coverage.test.ts`
re-runs the extractor and fails on any difference.

**Why source, not the emitted `.d.ts`.** The sources carry the TSDoc, the literal `dependsOn` array
and the `declare module "@stargantt/core"` blocks in one place, and reading them does not require
the library to have been built.

**Why the AST, not the type checker.** Everything extracted is syntax. Type resolution would cost a
full program build across 55 packages and would inline the very named types the documentation wants
to show.

**Why committed rather than built on the fly.** A generated-at-build artifact is always current and
therefore never diffable. Committing it means an API change that the documentation has not caught
up with appears as a reviewable diff in the same commit that broke it.

---

## D-06 — The site is written in English

**Ruling.** Page content, code comments, tests and this ledger are English, applying SGC-529 as-is.
`user-docs/CLAUDE.md` is the single exception, matching the root `CLAUDE.md`.

**Why.** Review, generation and the tests all read the same prose; one language keeps them
consistent. Japanese content is a separate cycle with its own translation-sync tests, not a thing to
half-do now.

---

## D-07 — One plugin is exactly two pages

**Ruling.** A tabbed reference page (`/reference/<name>`) and a config detail page
(`/reference/<name>/config`). Never one page, never one page per option.

**Why.** The tabbed page is the API-surface checklist — its tab strip is generated from `api.json`,
so an existing surface always has a tab and an empty one says so. The detail page is the sticky
split, which needs the whole scroll column to itself; putting it inside a tab would put
scroll-linked highlighting and tab switching in the same widget. Per-option pages would pass 500
URLs and make comparing two related options impossible.

---

## D-08 — A property's first value is the plugin's own default, and prerequisites are separate

**Ruling.** `values[0]` must configure nothing. Configuration an option needs before it can be seen
at all — `labelPlacement` has nothing to place without a `label` provider — goes in
`prerequisite`, which is applied only while a non-default value is selected.

**Why.** The config detail page shows one chart for the whole page, and every option is
demonstrated against it. If any option's resting state configured something, the baseline every
*other* option is measured against would be silently wrong. This was found by the test, not by
review: the first draft folded the label provider into `labelPlacement`'s default value and turned
labels on for the entire page.

---

## D-09 — An option with no visual demo costs an explicit reason

**Ruling.** `demo: { kind: "none", reason }`, where `reason` is longer than 40 characters. The test
enforces the shape and the length; it does not judge the content.

**Why.** Message catalogues, locale tags and paint callbacks have no honest before/after chart. A
rule with no escape hatch would be met with a fake demo, which is worse than none. Requiring the
reason makes each exclusion a decision on the record that a reviewer can count and disagree with,
rather than an omission that looks identical to unfinished work.

---

## D-10 — Prose must not restate the TSDoc

**Ruling.** Each option's `prose` is at least two paragraphs and says when to reach for the option,
what it costs, and what it interacts with. The generated TSDoc appears on the same page, folded
under the prose. This is **not** machine-checked.

**Why not machine-checked.** Length and similarity thresholds are trivially satisfied by padding,
and would turn a quality bar into a word count. The check belongs to the review agent, which reads
both texts and can tell a restatement from an explanation. The tests enforce presence and shape;
the reviewer enforces worth.

---

## D-11 — An empty API surface is stated, never omitted

**Ruling.** A plugin with no events still has an Events tab, and that tab says why there are none.
The text comes from `notes.<kind>.__empty` and the coverage test requires it.

**Why.** An absent section and an unfinished section look the same to a reader. "This plugin emits
no events; subscribe to data-store instead" is information. A missing tab is a question.

---

## D-12 — Library bugs found while writing docs are reported, not fixed

**Ruling.** An author who finds the library misbehaving — an example that does not reproduce, a
behaviour that contradicts the contract, a crash — writes an HTML report into
`user-docs-bug-findings/` and moves on. They do not change `packages/`.

**Why.** A documentation pass touches every plugin and will find things. Letting authors fix them
mixes an unreviewed library change into a docs commit, and does it in parallel across many agents
who cannot see each other's edits. Reports collect the findings where a human can triage them,
which is the same rule the repository already applies to mechanical refactors: report divergences,
rule on them separately.

---

## D-13 — End-to-end tests check that pages run, not what they look like

**Ruling.** The site's Playwright suite asserts: no page error, a real chart mounted with its
accessible tree, every tab rendering, no example reporting itself broken, and no horizontal
overflow at 720×540. No screenshot baselines.

On demos it is absolute: **every** value picker on a config page must repaint. Each is driven
through all of its values and compared against the page's resting chart; a picker that renders
identically at every value fails the page by name. There is no ratio and no allowance — an option
with no visual consequence belongs in `demo: { kind: "none", reason }` (D-09), where the reason is
on the record, not behind a picker that offers a reader a choice between two identical charts.

**Why.** At a hundred-plus pages, baselines cost more to maintain than they catch, and a green
baseline is evidence a page did not change — not evidence it works. The pixel comparison used here
is a same-run before/after of one chart, which needs no stored image and answers the question that
actually matters: does this option demonstrate anything at all.

**Second history, same lesson.** The gate then spent a while quietly measuring the wrong frame.
`settle()` screenshots until two consecutive shots match — but two identical frames are also what a
chart that has not *started* rebuilding looks like, so any value whose rebuild took longer than the
100 ms sampling interval was scored against the **previous** value's chart. Nothing looked wrong: a
stale frame is a perfectly valid-looking one, and the results were unstable rather than obviously
false, so the suite passed most of the time. Adding an unrelated stylesheet shifted the timing and
turned five pages red at once, which is how it was found.

The fix is to stop inferring. `GanttPreview` now publishes a mount counter as `data-render`, and
every measurement waits for that counter to move before letting the pixels settle — a fact the page
states rather than a delay the test guesses. The five failures were then all real, and all the same
defect: an option whose effect lands outside the visible frame. Three width options were capped
(`panes` never squeezes the chart below `--sg-chart-min-width`, so a `paneWidth: 760` beside a
column of prose is still about 200 px, and every column past the first was off the right edge); one
threshold hid its last on-screen marker; one demo matched the same task twice. Every one of them had
been written by an author who reasoned about what the option does and never checked what the page
shows. **A timing-based test does not fail safe — it fails quiet**, and what it was hiding was six
demos that argued nothing.

**History, because it is the point.** The first implementation checked only the first picker on
each page. Broadening it surfaced options that genuinely cannot repaint, and the reflex fix was to
relax the assertion to a 60% majority — which would have let two of every five demos demonstrate
nothing and still go green. A review agent caught that the relaxed test no longer matched what this
ruling claimed, and it was right: the ledger and the gate had silently diverged. The resolution was
to make the gate absolute and reclassify the honest exceptions as `kind: "none"`, which is what
D-09 exists for. A rule with a percentage in it is a rule that has stopped being one.

---

## D-14 — A review finding is evidence, not a verdict

**Ruling.** An author who believes a finding is wrong records it as disputed, with the file, line and
reasoning that refutes it, and does not apply it. A second reviewer then judges the dispute against
the source. Applying a fix you believe is wrong, to clear a finding, is a defect.

**Why.** Reviews here are adversarial by design, which makes them productive and occasionally makes
them wrong. Both failure modes appeared in the same run. A page's prose was "fixed" to clear a
finding and the replacement was false in a new way — the finding survived to a third round because
each round had been checking whether something *changed*, not whether the result was *true*. And a
guide was reported as rendering no baselines at all, in detail, with row dates; the author measured
the live page instead of complying, found the chart rendering exactly what the prose claimed, and
refused. The orchestrator screenshotted it and the author was right.

**How it is worded to the fixer.** Go to the file and line the finding cites, read it yourself, then
write what is actually true. Do not paraphrase the reviewer's proposed fix without checking it. The
default is still that the reviewer is right — they read the source independently — but the default
is rebuttable by evidence, and only by evidence.

**Cap.** Three rounds. What is left after that goes to the orchestrator, who arbitrates on the
evidence or escalates to a human. Findings that survive a cap are not waived by surviving it.

---

## D-15 — Search is a generated index, scored by hand

**Ruling.** `tools/build-content-index.ts` writes `src/generated/search-index.json`; the file is
committed and the coverage test re-runs the builder and fails on any difference, exactly as
`api.json` does (D-05). `src/lib/search.ts` scores it. No search library, and no runtime dependency
added for this.

**What is indexed.** Identifiers and one line each: plugin ids, option names, service / event /
command / extension-point keys, guide and chapter titles, recipe titles — 479 entries. **Not** the
body prose. Full text would multiply the index for hits that drop a reader into the middle of a
paragraph they then have to read anyway, and what someone searching an API reference knows is the
*name* of the thing.

**Why generated rather than derived in the browser.** The index covers every page, so deriving it at
runtime means loading every content module before the reader has typed anything — the exact cost
lazy page loading exists to avoid. The generated file is one 43 kB (gzipped) chunk fetched on first
use and never on page load.

**Why the builder imports the content modules instead of parsing them.** They are plain data. An
index built from a parse of an object literal can silently disagree with the page it points at;
one built from the object itself cannot. Node needs a nine-line resolve hook for Vite's
extensionless imports, and that is the whole cost.

**Why a hand-written scorer.** The one thing a generic tokeniser gets wrong here is the only thing
that matters: `rowHeight` has to be findable by typing `row height`, and `view/rowToggle` by typing
`rowToggle`. Titles are split on camel-case and on `.` / `/` and each part is matched in its own
right. Terms are ANDed — with 111 option names indexed, an OR search for two words returns
everything that has either.

**What the tests hold.** Index freshness; every hit's route is one the site serves; every plugin is
found by its short name and is the *top* hit; every one of the 111 options is found by
`<plugin> <option>`; the camel-case and namespace cases above; and an E2E pass covering the parts a
unit test cannot reach — that the chunk is actually emitted and fetched, the keyboard path, and
that a hit lands on the right tab or scrolls to the right option.

**Consequence, accepted.** A hit for a service or event needed somewhere to land, so a plugin's tab
strip became addressable as `?tab=events`. That is a URL the site now owes compatibility to.

---

## D-16 — A page loads its own content, and a chart is built when it is reached

**Ruling.** The content globs in `src/content/registry.ts` are **not** eager. Page identity — a
guide's slug and title, which module backs which plugin id — comes from
`src/generated/content-manifest.json`, generated and freshness-checked like every other artifact
(D-05), so the sidebar, the router and the route list are built without importing a content module.
A page's module is fetched when the reader navigates to it. `GanttPreview` builds its chart when it
comes within one screen of the scroll container, and keeps it thereafter. CodeMirror, sucrase and
the StarGantt bundle itself are dynamic imports.

**Why.** The site shipped a 2.7 MB script, 858 kB gzipped, to show one page. A megabyte of that was
the prose of the other 129 pages; the rest was an editor and a compiler for cells the reader may
never edit, and the library, which no page needs before its first chart. The initial script is now
**404 kB, 118 kB gzipped** — a seventh — and each page pulls its own 5–25 kB of content beside it.

**Consequences, accepted.**

- **An eager glob may not live under `src/`.** It compiles to a static import of everything it
  matches, so one left in the app puts the whole corpus back regardless of how pages are loaded.
  The tests want the opposite — every document at once, synchronously, so `describe.each` can name
  them — so their eager globs live in `test/_all-content.ts`, which nothing under `src/` imports.
- **The manifest is a second thing that can go stale.** It carries each page's title, which the
  sidebar shows and the page renders, so the test asserts they agree; a drift would show a reader
  one name in the nav and another on the page.
- **Rendering is asynchronous now**, so the E2E helper waits for the route's content before
  asserting, and a chart below the fold is reached by scrolling to it. Both are what a reader does.

**And the flake it shipped after that.** With charts mounting on approach, the E2E's
`toBeVisible()` on a canvas leant on Playwright's 5 s default, which a guide holding six charts
exceeded whenever the other workers had the machine busy — one test in three full runs, a different
one each time. The chart was fine; the clock was not. Every mount assertion now waits on
`data-render`, the same deterministic signal D-13's gate uses, and treats the canvas as
corroboration rather than as the timer. **A wait on a fact does not flake; a wait on a duration
does.**

**The bug this ruling's own implementation shipped, because it is instructive.** The first
`IntersectionObserver` used the default root, the viewport, with `rootMargin: "100% 0px"`. Every
chart below the fold then never mounted at all: `rootMargin` grows the *root*, while an element
clipped out of an intermediate scroll container has an empty visible rect no matter how large the
root is — and this site scrolls `.main`, not the window. Sixty tests failed at once, which is the
good outcome; the bad one was available, since a lazily-mounted chart that never mounts looks
exactly like a slow one.

---

## D-17 — A guide is a walkthrough; the reference pages carry the depth

**Ruling.** Guides are written plainly. Short sentences, one idea each, second person, and the
question a reader arrived with answered before anything is qualified. What a setting does and when
to reach for it belongs in a guide; why the library is built the way it is, what the kernel
guarantees, and the exact tolerances of an API do not — those are the core chapters' and the
reference pages' job, and every guide links to them. Reference and config pages keep the density
they have: they are the place a reader goes *for* it.

**Why.** All fifteen guides had drifted into essays. `your-first-chart` — the first page a reader
sees — spent one paragraph enumerating every plugin in the standard preset and another explaining
that the kernel does not privilege drawing. `loading-your-data` explained, in a guide about the
shape of an array, that a `load(json)` → `toJSON()` round trip is not byte-identical for authored
data whose parent rows carry an unexpected `type`. Every sentence was true and most were
interesting; together they buried "give the element a height" under material a reader cannot use
until much later. This is a user manual before it is a design record.

**Consequences, accepted.**

- **Real facts were cut, not relocated.** Where the same fact was already on a reference page it is
  simply gone from the guide; where it was not, it is a sentence rather than a paragraph. A reader
  who wants the paragraph now has to follow a link. That is the trade.
- **The runnable cells are unchanged.** They are what the demo-distinctness gate (D-13) and the
  E2E check, and they were never the problem — the prose around them was.
- **This is a style rule with no test behind it.** Nothing fails when a guide grows a
  three-hundred-word paragraph again. The coverage test still only asserts a guide has prose and
  something runnable in it.

---

## D-18 — The page shows the reader's material, not the site's own

**Ruling.** Site chrome carries what a reader can act on. Removed: the header's
"n/n plugins documented" counter, the per-page provenance pills (`⚙ generated from source`,
`✎ hand-written`), the `opt-in` / `in presetStandard()` badges, the plugin and option counts on the
landing page, the tab counts, and the config table's "n values" column. Kept: whether a plugin needs
adding — as the code in each page's *Installing it* block, which is the form a reader can copy —
and the `todo` marker on an undocumented plugin, which is a debt this site owes (D-04).

Colour never carries a distinction on its own here either: the landing page's plugin chips no longer
tint by preset membership, because the tint was the only thing saying so.

**Why.** How a table was produced is this project's business, not the reader's. A count of how many
plugins are documented answers a question only the people writing the site have. Each of these cost
a strip of visual noise near the title, above the thing the reader came for.

**And the theme button that came with it.** The site follows the OS scheme by default and the top
bar offers system → light → dark, stored per reader. One consequence is worth its own line, because
it is a rule the library states and this site had to obey: **a chart watches its own element for a
theme change, never its ancestors.** Writing `data-theme` on `<html>` gives every mounted chart new
CSS values and no idea they moved, and it repaints half in one scheme and half in the other. Each
`GanttPreview` therefore subscribes to the button and calls `theme.refresh()` on the instance it
owns — the documented way for a host to say "something outside your element changed". The E2E for
it reads the canvas's own pixels rather than the CSS variables behind them, and was confirmed to
fail with the `refresh()` call removed.

**And the Run button.** A guide's demo cell ran on every keystroke, rebuilding a whole gantt
instance per character — including the half-typed ones, whose only product was an error the reader
was already fixing. Cells now run once on arrival, so a reader who only reads still sees a working
chart, and after that only on Run (or Ctrl/Cmd+Enter).

---

## D-19 — `code` spans are markup; everything else is literal

**Ruling.** Hand-written prose supports exactly one piece of markup: a backtick pair around an
inline `code` span, rendered as `<code>` by `RichText` wherever the site prints an author's
sentence — guide paragraphs, plugin overviews, per-option prose, callouts, captions and the
generated TSDoc alike. Nothing else is markup: an unpaired backtick stays a backtick, a span may not
cross a line, and there is no bold, no link and no list syntax. A guide that needs a listing rather
than a sentence uses a `code` cell, which is not runnable and carries a language label.

**Why.** The corpus had been written for two years on the assumption that something rendered the
marks. Nothing did — **2,976 of them were on screen as punctuation**, mostly on the reference pages,
where an identifier mid-sentence is unavoidable and a bare `rowHeight` in a proportional font reads
as an English word. The fix is one twelve-line parser and one component; the alternative, a Markdown
dependency, would buy syntax nobody asked for and a decision about what to do with every way prose
could get it wrong.

**Consequences, accepted.**

- **The marks are load-bearing text now**, so a sweep that adds them can damage things that are not
  prose. One did: it marked a guide's `slug`, which turned a route into a 404, and the only reason
  that surfaced was another guide happening to link to it. The coverage test now asserts directly
  that no slug, title, route or plugin id contains a mark, and that every authored string has an
  even number of them.
- **Ambiguous words stay plain.** `progress`, `background`, `total`, `range`, `type` and `open` are
  each both an option and an English word; a regex marking them is wrong about half the time, so
  they were marked by hand where they name the option and left alone where they do not.
- **The search index strips them** (`withoutMarks`), because a backtick in a result snippet is noise
  a reader never typed.

**And the listings.** A guide's runnable cell takes a `DemoSpec` expression and mounts it, so
anything that is not one — the whole HTML page, a stylesheet rule, a `declare module` block — had
nowhere to go and was being written as a sentence with code embedded in it. `your-first-chart` now
opens with the complete page a reader can paste, and `loading-your-data`, `theming` and
`writing-a-plugin` each carry the listing their prose had been describing.

---

## D-20 — A listing is the same editor, held read-only

**Ruling.** Every multi-line listing on the site is rendered by `StaticCode`, which is
`LazyCodeEditor` with `readOnly` and a grammar: the 24 `code` cells in guides and core chapters, the
155 recipes on the reference pages, each page's *Installing it* block and the landing page's install
snippet. The grammar comes from the cell's own gutter label (`ts`, `html`, `css`), defaulting to
TypeScript. `@codemirror/lang-html` and `@codemirror/lang-css` are site dependencies, which D-02
exists to keep separable from the library's own zero-dependency rule.

The exception is the one-line `key: type` row on the API tables. It is a table cell carrying a
signature, not a listing, and mounting a few hundred editors to colour it buys nothing. `pre.code`
survives in the stylesheet for it and for the Suspense fallback.

**Why the editor rather than a highlighter.** Only the editable cell was ever highlighted, so a
reader met the same TypeScript in two forms — coloured where it could be typed into, flat everywhere
else — and the difference said nothing true. The config detail page had already solved this by
holding the editor read-only, so adopting that everywhere costs one component and no second opinion
about what a keyword looks like. A hand-written tokeniser would have been smaller and would have
disagreed with the editor at every edge.

**What the grammars cost.** The editor chunk goes from 400 kB (136 kB gzipped) to 463 kB (162 kB),
and the initial script does not move at all — 406 kB, 120 kB gzipped, the same as before.

**Consequences, accepted.** The landing page now fetches the CodeMirror chunk. It is behind the same
`Suspense` fallback as everywhere else — a plain block of the same text, at the same size — so the
first paint is unchanged; D-16 is about what blocks the first screen, not about how many chunks a
page eventually pulls. Read-only also means not editable and *not a tab stop*, which is what keeps a
reference page holding a dozen recipes from putting a dozen stops between a reader and the next
link. The E2E asserts colour rather than editor count: an editor whose grammar never matched renders
one flat colour, which is exactly the state a `<pre>` was already in and is invisible in a count.

---

## D-21 — A runnable cell shows the call it makes

**Ruling.** Under every runnable cell sits one `<details>`, *the call this makes*, holding the whole
`create()` call the cell stands for — generated by `printCall()` from the spec that actually ran, so
an edited cell answers for itself. Closed by default; opening one opens the rest of the page's,
because they all answer the same question once.

**Why.** A cell holds a `DemoSpec`: `{ preset, plugins, data, height }`, a shape that exists only on
this site and appears in no reader's project. `your-first-chart` — the first page a reader lands on —
introduced its first cell with "the cell below is that call [`presetStandard()`], running for real",
and then showed `{ preset: { treeGrid: { rowHeight: 36 } } }`, which is not that call and not
anything a reader would write. The sentence was false and the object was unexplained, on page one.
The editable part is worth keeping small; what was missing was where it lands.

**How the opt-in plugins are printed.** `spec.plugins` is a function of the bundle namespace, so its
own source is the only record of which factories it calls: the parameter name is read off the arrow
and `<param>.` is rewritten to `StarGantt.`. Anything that is not a plain arrow returning an array
prints `...extraPlugins` instead of a guess — a wrong listing beside a working chart is worse than
an unspecific one.

**Consequences, accepted.** `printSpec()` and `printCall()` now both unquote identifier keys, so the
config pane on the reference pages reads as source rather than as JSON. And the guide prose says the
shape once, in `your-first-chart`, rather than at every cell — a reader arriving mid-corpus meets
the disclosure rather than the explanation, which is the trade for not repeating it fifteen times.

---

## D-22 — The site has a texture; the prose it carries does not pay for it

**Ruling.** The site's visual identity is one dot field, one wash and one pair of accents.

- **The dot field** is a header band, painted once by `.main::before` at ~10% of the text colour on
  a 14px grid, 300px tall and masked out over its lower half. It sits behind a page's title and
  lede and is gone before the prose starts: a reading column set on a pattern is harder to read,
  which is the whole cost of the texture and none of its benefit. One owner only — a second copy on
  an element that scrolls differently slides out of register the moment the page moves.
- **The wash** (`--tint`) is a corner gradient that fades out inside the first 300px of a page, and
  covers the landing hero's full height. It marks where a page begins and is gone before the first
  section rule.
- **A page with a hero suppresses both.** The hero paints the wash and the dots over its own full
  height, `.main:has(.hero)::before` is dropped, and `.hero + .page` drops its wash. Otherwise the
  landing page starts a second wash a few pixels below the first — which reads as banding — and the
  dot band, sized to a title rather than to that hero, spills past the rule that is supposed to end
  it.
- **The accents** are a violet (`--accent`) and a teal (`--accent-2`). The violet carries links,
  active navigation, focus and the eyebrow over each page title; the teal carries string literals in
  code and the marks that must not read as links. Only the brand mark uses both at once.

Furniture is monospace — the eyebrow, cell gutters, type columns, chips, the disclosure summaries.
Headings, prose and sidebar links stay in the sans face at their existing sizes.

**Why.** The site was legible and anonymous: it stated nothing about the library above it, and a
reader could not tell it apart from any other generated documentation. Texture and a distinct accent
pair are the cheapest way to fix that, and the cheapest way to break the page is to let them touch
the reading column. Fixing them to *one* owner each is what keeps "make it look better" from
becoming a slow accumulation of gradients.

**What this does not touch.** Chart colours. Every bar, gridline and label on this site is drawn by
the library from its own CSS custom properties, which are its single source of truth (D-03). The
site's accents and a chart's palette are deliberately allowed to differ: what the reader sees in a
preview is what they will get in their own project, not what this page wished it looked like.

**Consequences, accepted.** `--on-accent` exists because white text on the dark scheme's lighter
violet is a 2.4:1 fill — the primary button and the pressed segmented control now flip their label
colour with the scheme rather than the fill being darkened for one scheme only. Column headers moved
from `--fg-faint` to `--fg-muted` for the same reason: 10.5px uppercase on the sunken fill measured
4.47:1, under the 4.5:1 floor.

---

## D-23 — The overview chart shows the plugin configured, not the plugin at its defaults

**Question.** Every reference page ends with a live chart, mounted from the page's `demo` — the
plugin present and unconfigured. For how many plugins is that a picture of the plugin?

**Ruling.** The overview tab mounts `overviewDemo`, which is a separate field: the **smallest
configuration that makes this plugin's effect visible**, together with a caption naming what to
look at, and the printed config above the chart so the reader can reproduce it. A plugin no static
chart can show at all uses `{ kind: "none", reason }` and pays a reason the test measures.

`demo` keeps its old meaning and its old job: the plugin at rest, and the baseline the **config
detail page** measures every option against. That page is unchanged — D-08 still holds there, and
holds for the same reason it always did.

**Why.** At defaults, roughly half the corpus drew a chart indistinguishable from one without the
plugin: `conditional-format` with no rules, `filter-search` with no query, every opt-in plugin
whose demo never loaded the plugin at all (`demo: {}`). The page's most concrete claim — "here is
what this does" — was, for those pages, a picture of the standard preset. "Smallest" rather than
"realistic" is the standard because a full production config makes a second problem: with six
options set, a reader cannot tell which part of the picture came from which one.

**Why not one field for both.** Making `demo` itself configured would move that configuration into
the config page's baseline, where every option would then be demonstrated against a chart that
already has this plugin's features turned on — the exact failure D-08 was written to prevent.

**Enforced by.** `test/coverage.test.ts`: every plugin has an `overviewDemo`; a configured one has
a caption and sets something; an opt-in plugin's overview chart must load its own plugin.

---

## D-24 — The CSS tokens are a page, generated from the library's sources, and the page is exhaustive

**Question.** A reader restyling a chart needs to know which CSS custom properties exist. The
plugin pages name the ones they read in passing, and the theme reference explains the system, but
nowhere lists the set. Where do 152 token names live, and who keeps that list honest?

**Ruling.** Their own page at `/tokens`, with its own section in the sidebar. The rows are
generated into `src/generated/tokens.json` by `tools/extract-tokens.ts`; the explanation around
them — how an override reaches the chart, what each family paints — is written by hand in
`src/content/tokens.ts`. The page carries an explicit promise: **a `--sg-*` name that is not on it
is a name the library does not have.**

**Why generated.** The same reason D-05 gives for `api.json`, with one addition: a token is not an
export. It appears in no `.d.ts`, no autocomplete and no type error, so a reader has no second
source to check the documentation against. A hand-kept list that fell one token behind would be
indistinguishable, from the outside, from a library that does not have that token.

**Where the facts come from.** There is no external contract table for tokens — the stylesheet is
the registry: light and (where it differs) dark values come straight from
`packages/stargantt/src/styles/tokens.css`'s `@property` registrations and
`styles/layout.css`'s one themed rule, parsing each `light-dark(...)` declaration directly (see
`docs/specs/plugins/view.md`, which documents the theme surface folded into the `view` plugin).
Which plugin *reads* a token is derived the same way the group is — by scanning every plugin
package's own sources for the name — since there is no attribution column to read instead. The
canvas-read set and the forced-colours mapping come from the view plugin's own internal theme
modules, the derived properties from the stylesheet, the published `--sg-safe-*` lengths from the
renderer, and the retired names from the same internal modules' retirement map.

**How the promise is kept.** The extractor scans every library source for `--sg-*` and **refuses to
write a snapshot** that omits one; `test/tokens.test.ts` re-runs it, and checks the reverse
direction too — a row for a name nothing in the library uses would be advice to set something inert.
The scan's only exclusions follow from the naming convention (an uppercase letter, or a hyphen
continuing into a non-segment: `--sg-dialog-*` in a comment about a family), never a list of
exceptions somebody has to keep current.

**Grouping is mechanical.** A token belongs to the plugin the registry says reads it; failing that,
to a name prefix more than one package styles (`--sg-dialog-*`, which several plugins share);
failing that, to the single plugin whose sources are the only ones that name it; and what is left
is the chart's base surface. So a new plugin's tokens land in a group by existing. What they do not
get for free is the sentence saying what they paint: every group id must have a title and prose in
the content module, and the test fails by name when one does not.

**What the prose is not.** The registry's parentheticals are written for a reader of the contract
and open with the ruling that settled the row. Ruling and section references are stripped on the
way in (D-18), and what is left is kept only if it is a sentence rather than a scrap — a one-word
note under a token reads as an explanation while explaining nothing.

**Enforced by.** `test/tokens.test.ts` (freshness, both coverage directions, group prose, search
reachability) and the token block of `e2e/pages.spec.ts` (every row actually renders; the filter
narrows without losing the tail; a search hit lands on its row).
