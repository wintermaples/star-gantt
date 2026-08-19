# StarGantt

**A Gantt chart library where even the basics are plugins — with zero runtime dependencies.**

[Documentation](https://wintermaples.github.io/star-gantt/) ·
[Live examples](https://wintermaples.github.io/star-gantt/examples/) ·
[日本語版 README](./README.ja.md) (this English README is canonical)

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![Core: <12KB min](https://img.shields.io/badge/core-%3C12KB%20min-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

StarGantt is built like VS Code, not like a widget: a **micro-kernel of less than 12 KB**
(minified) that knows nothing about tasks, dates, or drawing, plus **15 official plugins**
that implement everything else — rendering, drag editing, dependencies, auto-scheduling,
critical path, baselines and earned value, resources, import/export, external data sync —
using only the same public API that your plugins get. Don't like a built-in behavior?
Replace the plugin.

## Quick start

```html
<div id="chart" style="height: 480px"></div>
<script src="stargantt.iife.js"></script>
<script>
  const gantt = StarGantt.create({
    element: document.getElementById("chart"),
    plugins: StarGantt.presetStandard(),
  });

  const day = 86400000;
  const t0 = Math.floor(Date.now() / day) * day;
  gantt.service("stargantt.data").load({
    tasks: [
      { id: "root", parentId: null, name: "Release prep", type: "summary", start: t0, end: t0 + 20 * day },
      { id: "spec", parentId: "root", name: "Design", start: t0, end: t0 + 5 * day, progress: 1 },
      { id: "impl", parentId: "root", name: "Implementation", start: t0 + 5 * day, end: t0 + 15 * day, progress: 0.4 },
      { id: "qa", parentId: "root", name: "Verification", start: t0 + 15 * day, end: t0 + 20 * day },
      { id: "ship", parentId: "root", name: "Release", type: "milestone", start: t0 + 20 * day, end: t0 + 20 * day },
    ],
    links: [
      { id: "l1", sourceId: "spec", targetId: "impl", type: "FS" },
      { id: "l2", sourceId: "impl", targetId: "qa", type: "FS" },
      { id: "l3", sourceId: "qa", targetId: "ship", type: "FS" },
    ],
  });
</script>
```

That is a complete application: **one HTML file, one script tag**. Styles are injected by
`create()`. Or with a bundler:

```ts
import { create, presetStandard } from "stargantt";

const gantt = create({
  element: document.getElementById("chart")!,
  plugins: presetStandard(), // configurable via PresetStandardConfig
});
gantt.service("stargantt.data").load({ tasks, links }); // fully typed
```

The six opt-in plugins are composed onto the preset by name:

```ts
import { create, presetStandard, tracking, resource } from "stargantt";

const gantt = create({
  element,
  plugins: [...presetStandard(), tracking({ baselines: {} }), resource()],
});
```

## Install

```bash
npm install stargantt          # everything: core + all 15 official plugins (ESM + IIFE)
```

Or compose exactly what you need:

```bash
npm install @stargantt/core @stargantt/preset-standard
npm install @stargantt/plugin-tracking      # any individual official plugin
npm install @stargantt/sdk                  # for writing your own plugins
```

Requirements: a desktop/tablet-class viewport (720 × 540 px or larger). There is no
mobile-phone layout, by design.

## Packages

| Package | What it is |
|---|---|
| `stargantt` | Single-file distribution: core + all 15 official plugins, ESM + IIFE, CSS embedded |
| `@stargantt/preset-standard` | The standard 9-plugin composition (`presetStandard()`) |
| `@stargantt/core` | The micro-kernel (<12 KB minified, enforced in CI) |
| `@stargantt/sdk` | Typed helpers for plugin authors |
| `@stargantt/plugin-*` | The 15 official plugins, individually installable |

## Official plugins

Part of `presetStandard()`:

| Plugin | ID | Does |
|---|---|---|
| data-store | `stargantt.data-store` | Tasks, links, resources, assignments, custom fields; every change is a reversible transaction |
| view | `stargantt.view` | Renderer, pane layout, theming, timeline axis and header, grid and today line |
| tree-grid | `stargantt.tree-grid` | Left-hand grid pane and row model, field columns, cell editing, rule-driven bar colouring |
| task-bars | `stargantt.task-bars` | Draws the bars; owns the bar geometry every other plugin measures against |
| interaction | `stargantt.interaction` | Selection, drag-edit, snapping, tooltips, context menu, zoom, clipboard, filter/search, edit dialog |
| undo-redo | `stargantt.undo-redo` | Transaction history: undo replays in reverse, redo forward again |
| a11y | `stargantt.a11y` | Keyboard operability and screen-reader support; extensible shortcut table |
| scheduling | `stargantt.scheduling` | Dependency links, auto-schedule engine, working calendars, critical path, diagnostics |
| export | `stargantt.export` | Image/PDF export, CSV/JSON/iCal/MS-Project interchange, .xlsx writer, read-only embed viewing |

Opt-in (bundled, activated by adding their factory to `plugins`):

| Plugin | ID | Does |
|---|---|---|
| tracking | `stargantt.tracking` | Baselines and slip, progress tracking, cost accounting, earned-value management |
| resource | `stargantt.resource` | Resource ledger, assignment editor, resource-axis panel, over-allocation analysis, load chart |
| data-sync | `stargantt.data-sync` | REST/GraphQL snapshots with delta sync and optimistic write-back, offline snapshots, realtime transports |
| portfolio | `stargantt.portfolio` | Initiative–program–project hierarchy and a headless KPI dashboard |
| i18n | `stargantt.i18n` | Locale-keyed dictionary with a fallback chain, shared by all message catalogs |
| perf-tools | `stargantt.perf-tools` | Frame-time overlay and trace recorder for diagnosing paint performance |

## Architecture

- **The core knows nothing about Gantt charts.** It provides a plugin host, services,
  extension points, an event bus, and a command bus — nothing else. Tasks, dates, and
  rendering are all plugin territory.
- **No back doors.** Official plugins are built with exactly the public API third-party
  plugins get. Anything a built-in plugin can do, yours can too — including replacing a
  built-in wholesale.
- **Deterministic disposal.** Every resource a plugin creates (listeners, DOM, timers) is
  registered through `ctx.own()`, and the core owns teardown.
- **Zero runtime dependencies.** Nothing under `dependencies` except workspace-internal
  `@stargantt/*` packages, which are part of the library itself.

The full specification lives in [`docs/specs/`](./docs/specs/) — `architecture.md`, the
SDK spec, and one spec per plugin.

## Documentation

- [User documentation](https://wintermaples.github.io/star-gantt/) — guides, plugin
  references, and the API reference; every chart on it is a live StarGantt instance.
- [Examples](https://wintermaples.github.io/star-gantt/examples/) — 47 self-contained
  demo pages, each one HTML file against the released bundle.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Short version: this is a hobby project with no
support guarantee; the plugin architecture exists so you can build what you need without
waiting for a maintainer. Security reports: see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © wintermaples
