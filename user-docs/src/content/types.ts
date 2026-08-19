import type * as StarGanttNs from "stargantt";
import type { PresetStandardConfig } from "stargantt";

/** Everything the bundle exports, as a page author sees it inside a demo or a notebook cell. */
export type StarGanttApi = typeof StarGanttNs;

/**
 * Any plugin instance the bundle's factories return.
 *
 * `perfTools` is one of the six opt-in factories the bundle re-exports standalone (`tracking`,
 * `resource`, `portfolio`, `i18n`, `perfTools`, `dataSync`) — picked arbitrarily as the anchor
 * type, same shape as any other. The nine preset plugins (`dataStore`, `view`, `treeGrid`,
 * `taskBars`, `interaction`, `undoRedo`, `a11y`, `scheduling`, `export`) are NOT re-exported as
 * standalone factories — they are only reachable through `presetStandard()` — so none of
 * them can anchor this type.
 */
export type AnyPlugin = ReturnType<StarGanttApi["perfTools"]>;

/**
 * One chart a docs page can mount.
 *
 * `preset` covers the nine plugins of the standard preset. `plugins` is how an opt-in plugin
 * gets documented at all: it receives the bundle namespace and returns the extra plugin instances
 * to append, which is exactly the call a reader would write themselves.
 */
export interface DemoSpec {
  preset?: PresetStandardConfig;
  plugins?: (sg: StarGanttApi) => AnyPlugin[];
  /** Rows and links for this chart. Defaults to the shared sample dataset. */
  data?: readonly unknown[];
  /** Chart height in CSS px. Defaults to 300. */
  height?: number;
  /** Source text shown next to the chart. Defaults to a rendering of `preset`. */
  code?: string;
}

/** A value of one option, and the chart that shows what it does. */
export interface PropertyValue {
  /** Written as a reader would write it: `6`, `"inside"`, `{ placement: "right" }`. */
  label: string;
  demo: DemoSpec;
}

/**
 * How an option satisfies the live-demo rule.
 *
 * `values` is the normal case: at least two entries, the first of which is the plugin's own default
 * and must configure nothing, so an untouched page shows an unconfigured chart.
 *
 * `none` is the escape hatch for options with no visual consequence — message catalogues, locale
 * tags, callbacks whose effect is a value rather than a picture, options that only a service
 * caller can observe. It costs an explicit reason, which the tests require and a reviewer can
 * count, so "no demo" is always a decision on the record rather than an omission.
 */
export type PropertyDemo =
  | {
      kind: "values";
      /**
       * Configuration the option needs before it can be seen at all — `labelBackdrop` has nothing
       * to place until a `label` provider exists.
       *
       * Applied only while a non-default value is selected, never at rest. Folding a prerequisite
       * into the first value instead would leave the page's baseline chart quietly configured, so
       * every *other* option on the page would be demonstrated against the wrong starting point.
       */
      prerequisite?: DemoSpec;
      values: readonly PropertyValue[];
    }
  | { kind: "none"; reason: string };

/**
 * The chart at the bottom of a plugin's overview tab.
 *
 * `configured` carries the smallest configuration that makes this plugin's effect visible, plus the
 * one line that says what to look at. An unconfigured chart was the first draft of this, and for
 * roughly half the plugins it showed a reader the same picture the previous page showed them — a
 * plugin whose defaults draw nothing (a rule engine with no rules, an importer, a panel nothing has
 * opened) demonstrated itself by being indistinguishable from its own absence.
 *
 * `none` is the escape hatch for a plugin no static chart can show at all — one whose whole surface
 * is a call a host makes, or a file it writes. It costs an explicit reason, the same way a property
 * with no demo does.
 *
 * The config detail page does not use this: its baseline stays unconfigured so that every option is
 * measured against the plugin at rest.
 */
export type OverviewDemo =
  | {
      kind: "configured";
      spec: DemoSpec;
      /** What this configuration makes visible, in one line under the chart. */
      caption: string;
    }
  | { kind: "none"; reason: string };

export interface PropertyDoc {
  /** Must match an option name in `api.json` for this plugin. */
  name: string;
  /**
   * The explanation the TSDoc does not give: when you would reach for this, what it costs, what it
   * interacts with. Never a paraphrase of the generated description shown beside it.
   */
  prose: readonly string[];
  demo: PropertyDemo;
}

export interface Recipe {
  title: string;
  /** One or two sentences on the problem this solves. */
  intent: string;
  code: string;
}

/** A note attached to a generated API row — the "why", where the signature is the "what". */
export type MemberNotes = Readonly<Record<string, string>>;

export interface PluginDoc {
  /** Must match a plugin id in `api.json`. */
  id: string;
  /** One line for the index tables and the search results. */
  summary: string;
  /** The opening explanation of the reference page. Two paragraphs or more. */
  overview: readonly string[];
  /** When a reader needs this plugin, and what happens without it. */
  whenYouNeedIt: string;
  /**
   * The plugin present and unconfigured. This is the config detail page's baseline, which every
   * option on that page is demonstrated against — it is not what the overview tab shows.
   */
  demo: DemoSpec;
  /** The overview tab's chart: this plugin configured the smallest way that makes it visible. */
  overviewDemo: OverviewDemo;
  /** One entry per option in `api.json`, in the order the page should teach them. */
  properties: readonly PropertyDoc[];
  /** Optional prose per service / event / command / extension-point key. */
  notes?: {
    services?: MemberNotes;
    events?: MemberNotes;
    commands?: MemberNotes;
    extensionPoints?: MemberNotes;
  };
  recipes: readonly Recipe[];
}

/** A core chapter — the kernel has no config surface, so it is prose plus runnable cells. */
export interface CoreDoc {
  slug: string;
  title: string;
  lede: string;
  cells: readonly CoreCell[];
}

export type CoreCell =
  | { kind: "prose"; paragraphs: readonly string[] }
  | { kind: "demo"; caption?: string; spec: DemoSpec }
  | { kind: "code"; caption?: string; source: string };

/**
 * The CSS token reference: one page listing every `--sg-*` the library has.
 *
 * The rows are generated (`src/generated/tokens.json`) because a hand-kept list of 150 names is a
 * list that silently goes stale, and a token missing from this page is indistinguishable to a
 * reader from a token that does not exist. What is written by hand is everything the names alone
 * cannot say: how an override reaches the chart, and what each family of tokens is *for*.
 */
export interface TokensDoc {
  title: string;
  lede: string;
  /** The guidance above the table. Every one of these is prose a generator could not have written. */
  sections: readonly TokensSection[];
  /**
   * One entry per group in `tokens.json`, keyed by its generated id. A group with no entry fails
   * the coverage test: a new plugin's tokens must arrive with a sentence saying what they paint.
   */
  groups: readonly TokenGroupDoc[];
  /**
   * The three lists the page closes with, each of which is a token a reader can *meet* without
   * being able to set it: one the stylesheet derives, one the renderer writes out, and one the
   * library used to have. Each costs a sentence saying which kind it is.
   */
  appendix: { derived: string; published: string; retired: string };
}

export interface TokensSection {
  /** Also the anchor a link can point at, slugified. */
  heading: string;
  paragraphs: readonly string[];
  /** A listing the reader copies — an override block, a runtime call. */
  code?: { source: string; label?: string };
}

export interface TokenGroupDoc {
  /** Must match a group id in `tokens.json`. */
  id: string;
  /** The heading a reader scans for: `Task bars`, not `task-bars`. */
  title: string;
  /** What this family paints and what changing it costs. One paragraph, never a restatement. */
  prose: string;
}

/** A guide — the notebook layout: prose, editable config, live output, repeat. */
export interface GuideDoc {
  slug: string;
  title: string;
  lede: string;
  cells: readonly GuideCell[];
  /** Where to send the reader next. Routes, validated by the link test. */
  next: readonly string[];
}

export type GuideCell =
  | { kind: "prose"; paragraphs: readonly string[] }
  | { kind: "runnable"; source: string; height?: number; caption?: string }
  /**
   * A listing the reader copies rather than edits — the whole HTML page, a snippet of host code
   * around the chart, a shape of data. `runnable` cannot serve this: it takes a `DemoSpec`
   * expression and mounts it, so anything that is not one has nowhere to go.
   */
  | { kind: "code"; source: string; caption?: string; /** Gutter label. Defaults to `"ts"`. */ label?: string }
  | { kind: "callout"; tone: "info" | "warn"; body: string };
