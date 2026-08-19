import type { GuideDoc } from "../types";

/**
 * Colour is CSS, and the reader's first question is "how do I change the bar colour" — so that is
 * the first thing on the page. Presets, dark mode and forced colours follow. The full token list
 * is its own page (`/tokens`), and the audit API and the forced-colours mapping stay on the view
 * reference page (theme is now one of its nested config groups) — a guide names the few tokens a
 * reader starts with, not all 152.
 */
const doc: GuideDoc = {
  slug: "theming",
  title: "Theming and dark mode",
  lede: "Every colour in the chart comes from a CSS variable, so you restyle it with a stylesheet like anything else on your page.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "Bar fills, grid lines, the today line, the selection frame — all of them come from `--sg-*` CSS variables on the chart element.",
        "So the usual way to restyle a chart is a stylesheet rule of your own. Scope it to a class instead of `:root` if you have several charts with different looks on one page.",
        "This guide covers the handful you will reach for first. The CSS tokens page lists every one of them — both scheme values, which plugin reads each, and what happens under a forced palette — and is the page to search when you are looking for the name of something specific.",
      ],
    },
    {
      kind: "code",
      source: `/* Your stylesheet. Every chart on the page picks this up — no JavaScript involved. */
:root {
  --sg-bar-fill: #7c3aed;
  --sg-summary-fill: #4c1d95;
  --sg-focus-stroke: #7c3aed;
}

/* Or one chart at a time. */
.brand-chart {
  --sg-bar-fill: #0f766e;
}`,
      label: "css",
      caption: "the normal way to theme a chart",
    },
    {
      kind: "runnable",
      source: `{}`,
      caption: "the stylesheet's own palette — nothing overridden",
    },
    {
      kind: "prose",
      paragraphs: [
        "A docs page cannot hand you its stylesheet to edit, so the charts below use theme presets — named palettes you can switch at runtime.",
        "That is the second reason presets exist: a settings menu that lets your users pick a palette calls `setPreset(name)`, the same thing this cell does at startup.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: {
      theme: {
        presets: {
          violet: {
            '--sg-bar-fill': '#7c3aed',
            '--sg-summary-fill': '#4c1d95',
            '--sg-milestone-fill': '#2e1065',
            '--sg-focus-stroke': '#7c3aed',
          },
        },
        preset: 'violet',
      },
    },
  },
}`,
      caption: "a named palette, applied at startup",
    },
    {
      kind: "prose",
      paragraphs: [
        "Two presets ship with the library: `high-contrast` and `high-contrast-dark`. Both are checked against contrast standards, and both cover every token they need to.",
        "Reach for these before writing your own if accessibility is the goal — there is nothing to get wrong.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { theme: { preset: 'high-contrast-dark' } },
  },
}`,
      caption: "a bundled, contrast-checked palette",
    },
    {
      kind: "prose",
      paragraphs: [
        "Light and dark follow the reader's operating system by default, for the whole page and the chart alike. You do not have to do anything for dark mode to work.",
        "To pin one chart regardless of the OS, set `view.theme.colorScheme`.",
        "If your page has its own light/dark switch that writes an attribute on `<html>`, tell each chart when it flips by calling its theme service's `refresh()` — a chart watches its own element, not the page around it. This documentation site does exactly that for the button in its top bar.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { theme: { colorScheme: 'dark' } },
  },
}`,
      caption: "`colorScheme: 'dark'` pins this one chart, whatever the page does",
    },
    {
      kind: "prose",
      paragraphs: [
        "Here is the mistake to avoid: changing the background without changing the text colour that goes with it.",
        "Nothing is invalid, and the chart paints it happily. But the text is still the light theme's near-black, on a background it was never chosen for.",
        "Worse, whether you can see the problem depends on your own OS setting — on a dark-mode machine the text quietly resolves to a light colour and looks fine. The chart is still wrong.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: {
      theme: {
        presets: {
          brokenDark: { '--sg-bg': '#141414', '--sg-header-bg': '#141414' },
        },
        preset: 'brokenDark',
      },
    },
  },
  height: 260,
}`,
      height: 260,
      caption: "legal, and — on a light-mode machine — close to unreadable",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "Change colours in families. A new background needs new foreground, header and border colours to go with it, and a `colorScheme` pin so an unrelated OS setting cannot swap half of them back. If accessible-and-correct is the whole requirement, use a bundled preset instead.",
    },
  ],
  next: ["/tokens", "/reference/view", "/reference/view/config", "/guides/sizing-task-bars"],
};

export default doc;
