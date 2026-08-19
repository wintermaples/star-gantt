import type { TokensDoc } from "./types";

/**
 * The written half of the CSS token reference.
 *
 * The generated half — every token, its two values, which plugin(s) reference it — lives in
 * `src/generated/tokens.json`, built by `tools/extract-tokens.ts` straight from
 * `packages/stargantt/src/styles/{tokens,layout}.css`. There is no separate normative registry
 * document: the stylesheet is the registry. What is here is what a
 * generator cannot know from names and values alone: which declaration a host has to write for an
 * override to actually land, why a token can hold two values at once, and what each family of
 * names is *for*. A group with no entry here fails the coverage test, so a new plugin's tokens
 * cannot arrive on the page as a row nobody explained.
 */
const doc: TokensDoc = {
  title: "CSS tokens",
  lede:
    "Every colour, length and font the chart paints with is a CSS custom property you can " +
    "override from your own stylesheet. This page lists all of them — if a name is not here, the " +
    "library does not have it.",

  sections: [
    {
      heading: "Overriding a token",
      paragraphs: [
        "Declare the property on `:root` and the whole page follows. The library's own declarations " +
          "are written inside `:where(...)`, which gives them zero specificity, so your declaration " +
          "wins no matter which stylesheet the browser loaded first — the chart injects its styles " +
          "into `<head>` after yours, and without that trick it would win every tie.",
        "You can scope an override instead of applying it globally: any selector that matches the " +
          "chart element, or an ancestor of it, works the same way, because these properties inherit. " +
          "That is how two charts on one page can look different without either of them knowing.",
        "Nothing here needs `!important`. If an override appears to do nothing, the cause is almost " +
          "always one of three things: the name is retired (listed at the bottom of this page), the " +
          "chart carries a scheme class (see below), or the value is one the canvas reads and the " +
          "chart has not repainted yet — call `theme.refresh()` if you changed the declaration from " +
          "script rather than by loading a stylesheet.",
      ],
      code: {
        label: "css",
        source: `:root {
  --sg-bar-fill: #7c3aed;
  --sg-bar-radius: 6px;
  --sg-font-family: "Inter", system-ui, sans-serif;
}

/* One chart only — any selector that matches the element or an ancestor. */
.my-chart {
  --sg-bar-fill: #0ea5e9;
}`,
      },
    },
    {
      heading: "Light, dark, and the one gotcha",
      paragraphs: [
        "A token whose two schemes differ is declared once, as `light-dark(<light>, <dark>)`, and the " +
          "browser resolves it against the scheme in force. The table below shows both values; a token " +
          "with a single value is deliberately identical in both schemes.",
        "The chart follows the operating system by default. To pin the whole page, write " +
          '`:root { color-scheme: light }` or `dark`. To pin one chart, put `class="sg-scheme-dark"` ' +
          "on the chart element, or call `theme.setColorScheme(\"dark\")` from script.",
        "The gotcha: pinning a scheme on one chart re-declares the palette on that element itself, and a " +
          "declaration always beats an inherited one. So if you pin a per-chart scheme, write your own " +
          "overrides on a selector that matches the chart element too — `.my-chart.dark { --sg-bar-fill: ... }` " +
          "— rather than on `:root`, which the scheme class would shadow. A chart with no scheme class " +
          "is unaffected and the `:root` route keeps working.",
      ],
    },
    {
      heading: "What the canvas reads",
      paragraphs: [
        "Most of the chart is painted onto a canvas, which has no CSS of its own: the view plugin's " +
          "theme service reads the property off the document and hands the resolved value to the " +
          "painter. The tokens that travel that path are marked `canvas` in the table, and they are the " +
          "set a replacement palette has to cover in full — leave one out and that one surface keeps " +
          "the default value underneath your palette.",
        "`theme.tokens` is a store of exactly that set, mapped to the values currently in force — " +
          "subscribe to it to repaint your own overlay in step with the chart, or read `.get()` once to " +
          "diff your palette against what the chart is actually painting. The unmarked rows are " +
          "consumed by the stylesheet instead, so they follow your declaration with no involvement from " +
          "the plugin at all.",
      ],
      code: {
        source: `const theme = gantt.service("stargantt.theme");

theme.tokens.get();          // every canvas-read token → its resolved value, right now
theme.get("--sg-bar-fill");  // one resolved value, "" if unset
theme.refresh();             // re-read after changing declarations from script`,
      },
    },
    {
      heading: "Contrast is part of the value",
      paragraphs: [
        "The shipped defaults are audited: text clears 4.5:1 against the surface behind it, and marks " +
          "that carry meaning without text — bar fills, the selection frame, the focus ring, the today " +
          "line — clear 3:1. Brand colours dropped in without checking are the usual way a chart " +
          "becomes unreadable for someone, and the failure is invisible to the person who chose them.",
        "`theme.audit()` measures the palette actually in force and returns one entry per documented " +
          "figure/ground pair, each with the floor it is held to and whether it passes. It also checks " +
          "that the four row states — plain, striped, hovered, selected — keep moving away from the " +
          "background in that order, which is the thing a hand-picked palette most often inverts.",
      ],
      code: {
        source: `const failing = theme.audit().filter((entry) => !entry.ok);
// [{ id: "bar-fill/bg", kind: "contrast", measured: 1.9, min: 3, ok: false }, ...]`,
      },
    },
    {
      heading: "Presets and forced colours",
      paragraphs: [
        'A preset is a whole palette applied at once: `theme.setPreset("high-contrast-dark")` sets ' +
          "every canvas-read token as inline properties on the chart element, which outranks your " +
          "stylesheet for as long as it is applied, and `theme.setPreset(null)` puts your palette back. " +
          "Two WCAG-AAA high-contrast palettes ship with the library (`BUILT_IN_PRESETS`), and you can " +
          "register your own through the view plugin's `theme` config.",
        "When Windows High Contrast (or any `forced-colors` mode) is active, CSS is repainted by the " +
          "browser but a canvas is not — so the theme service maps each canvas-read token to the system " +
          "colour that plays the same role, shown in the `forced` column below. Tokens with no mapping " +
          "(fonts, lengths, decorative fills) are read normally or dropped.",
      ],
    },
  ],

  groups: [
    {
      id: "base",
      title: "The chart surface",
      prose:
        "The background, the text colours, the border and the typography every other part inherits " +
        "from, plus a handful of figures — the summary and milestone fills, the actual-dates bar, the " +
        "critical-path near-miss and negative-float marks, the tracking progress line — that more than " +
        "one plugin paints with and that therefore belong to no single one. Changing `--sg-bg` and " +
        "`--sg-fg` is the smallest possible restyle and the one most likely to be enough: almost every " +
        "other token in the table was chosen to sit at a measured distance from this pair, so moving it " +
        "moves the whole chart coherently.",
    },
    {
      id: "view",
      title: "Rows, scrollbars and the tooltip",
      prose:
        "The view plugin's own surface tokens: the row states (hover, selected, striped) and the " +
        "minimum row height the renderer lays every pane out against, the chart's own scrollbar thumb " +
        "(the chart scrolls its own viewport rather than the page, so it paints one), the today and " +
        "status lines, and the tooltip's surface and text. These span what would otherwise be five separate " +
        "narrowly-scoped areas — the renderer, grid-lines, today-line and theme surfaces, plus the tooltip " +
        "— all folded into `view` as one package.",
    },
    {
      id: "interaction",
      title: "The context menu and zoom toolbar",
      prose:
        "Two small DOM surfaces the interaction plugin owns outright: the right-click context menu's " +
        "background, text and hairline, and the floating zoom toolbar's background, label colour and " +
        "border. Both are DOM elements rather than canvas, so an override here is visible immediately, " +
        "with no `theme.refresh()` needed. The toolbar sits over the chart, so its background is opaque " +
        "by default — making it translucent is a common restyle and worth checking against a dense area " +
        "of bars before you keep it.",
    },
    {
      id: "resource",
      title: "The assignment editor",
      prose:
        "The resource plugin's inline editor for assigning resources to a task: its surface, text and " +
        "border, the chip drawn behind an assigned name, and the outline shown on a valid drop target " +
        "while dragging a resource onto a row. The drop outline is feedback mid-gesture, so it is held " +
        "to a contrast floor against both the editor surface and the row behind it, independent of " +
        "which scheme is active.",
    },
    {
      id: "perf-tools",
      title: "The perf overlay",
      prose:
        "The development overlay's surface and text — the frame-time readout and sparkline the perf-tools " +
        "plugin floats over a chart corner. It is a debugging aid rather than part of the product a " +
        "reader ships, so it is the one surface in the table where legibility over the chart's own " +
        "content matters more than blending in with it.",
    },
    {
      id: "bar",
      title: "Task bars",
      prose:
        "The figure of the whole chart: the fill of a normal bar, its corner radius, the optional " +
        "outline and bevel, the label colours inside and outside the bar with the label's own font " +
        "shorthand, and the opacity that turns a bar's own fill into its progress track underneath. " +
        "`--sg-bar-fill` is the single most consequential colour in the table — nearly everything else " +
        "here was measured against it, and several other families (critical-path, baselines, cost) " +
        "recolour a bar by substituting a different fill on top of this same shape.",
    },
    {
      id: "baseline",
      title: "Baselines and actuals",
      prose:
        "The saved-plan bar the tracking plugin draws under the current one, the actual-dates overlay " +
        "used to compare two plans, the slip labels — early in one colour, late in another, with their " +
        "own font token — and the two critical-path-added/removed marks a baseline comparison can " +
        "surface. The slip colours are the pair to check first if you restyle: they are text, so they " +
        "need 4.5:1, and they are the one red/green pair in the default palette.",
    },
    {
      id: "cost",
      title: "Cost curves",
      prose:
        "Two curve strokes — planned and actual — and four category strokes (labor, material, fixed, " +
        "variable) for the cost breakdown the tracking plugin's cost panel draws. Planned reads as a " +
        "reference line and actual as the attention mark, the same pairing the earned-value curves use " +
        "just below, so both panels can be read with one convention once you learn it.",
    },
    {
      id: "critical",
      title: "The critical path",
      prose:
        "The recoloured fill for a critical bar and the fill for the float bar scheduling draws beside " +
        "a near-critical one. This is the clearest case in the library of colour not being allowed to " +
        "carry meaning alone: the scheduling plugin also exposes the classification in the task data " +
        "itself, and the float bar is a distinct shape, so a reader who cannot separate the two hues " +
        "still gets the information from the data and the geometry.",
    },
    {
      id: "dialog",
      title: "Dialogs",
      prose:
        "Every modal the library opens — the edit dialog, delete confirmations, the export and import " +
        "sheets, the scheduling diagnostics panel — is built from one shared chrome, so these tokens " +
        "restyle all of them at once: the surface, its text, a secondary muted text colour, its " +
        "hairline, the draggable header, the drop shadow, the dim behind it, and the destructive " +
        "action's own pair of colours. Because the chrome is shared, a host theming its dialogs to " +
        "match a dark product only has to touch this one family.",
    },
    {
      id: "drag",
      title: "Drag ghosts",
      prose:
        "The translucent preview drawn while a bar is being dragged or resized. It is deliberately " +
        "weaker than the bar it previews — the ghost is a proposal, not a commitment, and reading as " +
        "solidly as the bar underneath it would make the two hard to tell apart mid-gesture, which " +
        "matters most on a touch or trackpad drag where the pointer itself obscures part of the row.",
    },
    {
      id: "evm",
      title: "Earned value curves",
      prose:
        "The three earned-value curves the tracking plugin's EVM panel draws: planned value, earned " +
        "value and actual cost. They are distinguished by hue in the default palette and by position in " +
        "the legend; if you recolour them, keep earned value as the emphasised line, since it is the " +
        "curve a reader looks for first when checking whether a project is ahead or behind.",
    },
    {
      id: "grid",
      title: "Gridlines and calendar shading",
      prose:
        "Ground, not figure: the vertical rules at fine and coarse tiers the view plugin draws, plus " +
        "the shading scheduling's calendars apply for non-working days, off-hours and zones. Every " +
        "value here is deliberately low-contrast — if you raise one until it competes with the bars, the " +
        "chart stops reading as bars on a calendar and starts reading as a grid with some bars in it.",
    },
    {
      id: "header",
      title: "The timeline header",
      prose:
        "The date band across the top of the chart: its surface, its two tiers of label text, the tick " +
        "marks between columns, and the band's own height. The two `-font` tokens are complete CSS " +
        "`font` shorthands rather than sizes, because the canvas painter needs one string to draw with; " +
        "the coarse tier differs from the fine one by weight alone, so recolouring one without the " +
        "other reads as an error rather than a choice.",
    },
    {
      id: "link",
      title: "Dependency links",
      prose:
        "The arrows scheduling draws between dependent bars: the resting line and its endpoint ports, " +
        "the emphasis colour for a highlighted dependency, and the driving-path colour used while " +
        "diagnosing a schedule. Emphasis is carried by line width as well as colour, so the distinction " +
        "survives a monochrome or forced-colours palette even if the two hues become indistinguishable.",
    },
    {
      id: "load",
      title: "The load chart",
      prose:
        "The resource plugin's workload band under the main chart: its own height and its lanes' " +
        "height, the bar fill and the over-capacity fill, the capacity line, the lane separators, zebra " +
        "striping and reference line, and the heatmap's cell surface, border and text. The over-capacity " +
        "fill is the one signal that matters most here, and it is paired with the capacity line crossing " +
        "it rather than left to colour alone to carry the warning.",
    },
    {
      id: "panel",
      title: "Docked panels",
      prose:
        "The surface, text and border shared by the docked side panels several plugins put beside the " +
        "chart — the interaction side panel, the scheduling diagnostics panel, the resource pool and " +
        "utilization panels. They resolve to the same values as the dialog chrome by default, which is " +
        "what makes a panel and a dialog read as one product rather than two different ones bolted " +
        "together.",
    },
    {
      id: "rag",
      title: "RAG status",
      prose:
        "The three red/amber/green badge fills the tracking plugin's progress panel draws, plus the " +
        "badge's own letter colour. The badge carries its letter — R, A, G — precisely so the status " +
        "survives for a reader who cannot separate the three hues; keep the letter legible against " +
        "whichever fills you choose if you restyle this family.",
    },
    {
      id: "ru",
      title: "Utilization overlays",
      prose:
        "The demand and supply strokes of the resource plugin's utilization overlay, and the warning " +
        "colour for an over-allocated period. Demand is the emphasised figure and supply the reference, " +
        "the same convention the cost and earned-value curves use — once you know the pattern in one " +
        "family, the other two read the same way.",
    },
    {
      id: "rubber",
      title: "Rubber-band selection",
      prose:
        "The fill and stroke of the rectangle drawn while a reader rubber-band-selects a range of bars, " +
        "or drags out a new dependency link before it has a target. Both gestures share the same visual " +
        "language on purpose — a translucent fill with a solid stroke — so a reader learns to read one " +
        "shape as \"you are choosing something\" no matter which chart feature triggered it.",
    },
    {
      id: "rv",
      title: "The resource pane",
      prose:
        "The resource-by-row view's own surface: its background and text, team-row headings, borders, " +
        "the assignment segments and their over-allocated variant, an accent colour, the lane fill, and " +
        "the two lengths that decide row height and the label column's width. Each colour falls back to " +
        "the matching chart-surface token, so a chart-level restyle already reaches this pane before you " +
        "touch anything here specifically.",
    },
    {
      id: "selection",
      title: "Selection marks",
      prose:
        "The frame drawn around a selected bar — its colour, its line width and how far it sits outside " +
        "the bar's own outline. It is the only signal that a bar is selected, so it is held to 3:1 " +
        "against both the bar fill underneath it and the chart background around it, in both colour " +
        "schemes, rather than left to whatever contrast a chosen hue happens to produce.",
    },
    {
      id: "taskfields",
      title: "Row field marks",
      prose:
        "The two marks the tree-grid plugin's field renderers paint into a row: a warning colour for a " +
        "field that fails validation, and the fill of the avatar circle behind an assignee's initials. " +
        "The avatar fill is scheme-shared (one value, not `light-dark()`) because it carries white " +
        "initials in both schemes and a second dark variant would need a second text colour to match.",
    },
    {
      id: "treegrid",
      title: "The grid pane",
      prose:
        "Two lengths that decide how the left-hand tree-grid pane is laid out: the width reserved for a " +
        "row's expand/collapse toggle, and the horizontal padding inside a cell. Both are read back by " +
        "the plugin rather than only applied by CSS, so a change to either one moves the text and the " +
        "clickable hit area together instead of the two drifting apart.",
    },
  ],

  appendix: {
    derived:
      "These are declared by the stylesheet in terms of other tokens rather than carrying a value of " +
      "their own — they exist so one declaration can move several related lengths at once. Setting " +
      "them directly works, but changing the token they derive from is usually what you actually want.",
    published:
      "These flow the other way: the renderer writes them onto the chart pane as an output of its own " +
      "layout, so an overlay of your own can position itself clear of the chart's furniture with plain " +
      "CSS — `top: calc(var(--sg-safe-top, 0px) + 8px)`. They have no default and no central " +
      "declaration, and setting them yourself does nothing; every plugin that reads one reads it " +
      "defensively, with its own `0px` fallback, for the moment before the renderer has published a " +
      "real value.",
    retired:
      "These names no longer exist. CSS accepts a declaration for a custom property nothing reads, so " +
      "a stylesheet carrying one keeps working and keeps having no effect — which is why the chart " +
      "warns about each of them once at start-up rather than leaving a reader to find out by looking " +
      "at a screenshot that never changes.",
  },
};

export default doc;
