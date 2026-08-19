/**
 * The examples index shell: the example pages are self-contained (following the pattern
 * `examples/basic.html` etc. established — inline styles, inline dataset functions, no shared
 * runtime chrome), so this file is loaded ONLY by `index.html`, where it renders the top bar, the
 * sidebar nav and the catalog grid from the single `CATALOG` array below.
 * Individual demo pages do not load this script; they are plain, complete HTML files that each
 * load only `../packages/stargantt/dist/stargantt.iife.js`.
 *
 * The catalog below is the single source of truth for what pages exist and how they are grouped.
 * Every `file` entry corresponds to a real file under `examples/`.
 *
 * Styling stays in the `.ex-*` namespace (examples.css). Nothing here touches `.sg-*` or `--sg-*`.
 */
(function () {
  "use strict";

  /** @type {{ category: string, pages: { file: string, title: string, blurb: string }[] }[]} */
  var CATALOG = [
  {
    category: "Getting started",
    pages: [
      {
        file: "hello.html",
        title: "Hello, StarGantt",
        blurb:
          "One HTML file and one script tag: the smallest possible chart.",
      },
      {
        file: "basic-gantt.html",
        title: "Basic gantt chart",
        blurb:
          "A read-only gantt chart with hierarchical tasks and dependencies, plus toggles for grid highlight zones, row hover fill, and RTL/bidi text direction.",
      },
      {
        file: "basic.html",
        title: "Basic example (performance harness)",
        blurb:
          "presetStandard() out of the box, plus a ?tasks=N deterministic generator and a first-paint readout used by the E2E performance suite.",
      },
      {
        file: "full-featured.html",
        title: "Full-featured chart",
        blurb:
          "All 15 official plugins composed in one self-contained HTML file — presetStandard()'s nine plus the six opt-in factories (tracking, resource, dataSync, portfolio, i18n, perfTools) — with every nested config group given a deliberate value. The combinations that cannot hold at once (a chart-pane corner's occupant, a bar's fill owner, the bottom region's height, the data origin, column layout, locale/direction) are arbitrated in a settings dialog whose choices persist in localStorage.",
      },
    ],
  },
  {
    category: "Display & theming",
    pages: [
      {
        file: "task-bars-display.html",
        title: "Task bar display options",
        blurb:
          "Label placements, duration/progress labels, milestone shapes, pattern fills, rounded corners, a custom bar renderer, bar-end icons and avatars, and the collapsed-summary mode — the taskBars nested config.",
      },
      {
        file: "conditional-format.html",
        title: "Conditional formatting",
        blurb:
          "Rule-driven bar colors, overdue warnings, progress-status coloring and a legend via the treeGrid.conditionalFormat nested config group.",
      },
      {
        file: "theming-css-vars.html",
        title: "Theming with CSS variables",
        blurb:
          "Switch themes live by changing the chart element's class and its --sg-* tokens, or apply bundled high-contrast / config-supplied presets via view.theme at runtime.",
      },
      {
        file: "task-fields.html",
        title: "Task fields and custom fields",
        blurb:
          "Status, priority, tags, deadlines, assignees and duration as editable columns, in-bar glyphs and a side-panel section via treeGrid.taskFields, plus typed and formula custom columns via dataStore.customFields.",
      },
      {
        file: "i18n.html",
        title: "Internationalization",
        blurb:
          "One inline dictionary (StarGantt.createDictionary) translates the grid, detail pane, zoom toolbar and context menu; switch between English, Japanese, a regional table and a deliberately partial French one, and watch the fallback chain resolve on rebuild via the opt-in i18n() plugin.",
      },
    ],
  },
  {
    category: "Interaction & editing",
    pages: [
      {
        file: "tree-grid-interaction.html",
        title: "Tree grid interaction",
        blurb:
          "Expand/collapse, column definitions, scroll sync, variable row heights, and outline editing — indent/outdent, row insert, expand-to-level, collapsed badges and auto-summary promotion.",
      },
      {
        file: "interaction.html",
        title: "Interaction",
        blurb:
          "The merged interaction plugin composed with presetStandard(): drag, selection, snap, tooltip, context menu and zoom controls in one nested config.",
      },
      {
        file: "drag-and-undo.html",
        title: "Drag editing and undo/redo",
        blurb:
          "Drag bars to move and resize them, step back and forth with Undo/Redo, and toggle the interaction.snap task-edge magnet.",
      },
      {
        file: "drag-edit-features.html",
        title: "Drag editing extensions",
        blurb:
          "interaction.dragEdit's extra fields: drag tooltip, single-pointer click-move, minimum duration, row-drag reordering, multi-selection drag, edge auto-scroll and frame-synced pointer moves.",
      },
      {
        file: "multi-select-rubber-band.html",
        title: "Multi-select and rubber-band",
        blurb:
          "Ctrl/Cmd toggle, Shift range and rubber-band selection with a live readout, plus select-all / clear / delete shortcuts and bulk delete with either the built-in confirmation dialog or a host confirmDelete hook, via interaction.selection.",
      },
      {
        file: "column-editing-sort.html",
        title: "Column editing and sort",
        blurb:
          "Custom tree-grid columns with getValue/setValue and the bundled StarGantt.selectEditor / StarGantt.dateEditor, plus wbs, columnLayout, cellRenderers, rowClass and collation toggles, header-click sort, column resize and an undo history readout.",
      },
      {
        file: "zoom-levels.html",
        title: "Zoom levels",
        blurb:
          "All six built-in zoom levels, the timeline/zoomIn / zoomOut commands, the interaction.zoomControls toolbar with keyboard zoom chords, and the axis's setup-time view.timeline options (week start, fiscal year, display time zone, header-cell template).",
      },
      {
        file: "filter-search.html",
        title: "Filter and search",
        blurb:
          "Incremental task search and checkbox value-list filtering via the interaction.filterSearch nested config group.",
      },
      {
        file: "a11y-export.html",
        title: "Accessibility and PNG export",
        blurb:
          "Keyboard navigation and the parallel ARIA treegrid, its dependency read-out, shortcut-help dialog and screen-reader summary table via a11y, plus exporting the chart as a PNG via the export facade.",
      },
      {
        file: "context-menu-clipboard.html",
        title: "Context menu and clipboard",
        blurb:
          "Right-press menu (insert / duplicate / delete / two-step links) extended through contextmenu/items, plus subtree copy-paste, in-place duplicate and spreadsheet TSV paste via the clipboard/* commands, each one undo step.",
      },
      {
        file: "insert-placement.html",
        title: "Insert placement",
        blurb:
          "Where an inserted task lands (a child by default, on the bar, the grid row or the empty lane) and how long it is (one grid cell of the current zoom), including inserting into a collapsed split row.",
      },
      {
        file: "custom-plugin.html",
        title: "Custom plugin",
        blurb:
          "Six third-party plugins written against the real v2 public API: renderer/layers, renderer/hitTest, tooltip/content, renderer/domOverlays, a custom extension point and a claimed task.meta key — composed the same way official opt-in plugins are (alongside presetStandard() in the plugins array).",
      },
    ],
  },
  {
    category: "Tracking",
    pages: [
      {
        file: "tracking.html",
        title: "Tracking",
        blurb:
          "The merged opt-in tracking plugin with all four nests enabled at once: baselines, progress, cost and EVM.",
      },
      {
        file: "baselines.html",
        title: "Baselines",
        blurb:
          "A preloaded plan-of-record snapshot with baseline underlay bars, actual bars from task.meta and per-bar slip indicators via tracking({ baselines }).",
      },
      {
        file: "progress-tracking.html",
        title: "Progress tracking",
        blurb:
          "RAG status badges, the zigzag progress line at the status date, and a single-undo bulk update panel via tracking({ progress }).",
      },
      {
        file: "cost-tracking.html",
        title: "Cost tracking",
        blurb:
          "Rate master, labor-cost estimation, budgets and alerts, and the budget-vs-actual / cost-curve panels via tracking({ cost }).",
      },
      {
        file: "evm.html",
        title: "Earned Value (EVM)",
        blurb:
          "PV/EV/AC with SPI/CPI/SV/CV and an EAC/ETC forecast — a KPI dashboard and a movable status-date line via tracking({ evm }) and view.todayLine.",
      },
    ],
  },
  {
    category: "Scheduling",
    pages: [
      {
        file: "scheduling.html",
        title: "Scheduling",
        blurb:
          "The merged scheduling plugin composed with presetStandard(): dependency links, a port-drag link creation gesture, and auto-reschedule.",
      },
      {
        file: "dependencies-scheduling.html",
        title: "Dependencies and scheduling",
        blurb:
          "Dependency links with per-type colours, conflict and driving emphasis, link editing and the inspector panel, plus manual/auto scheduling, constraints and status-date reschedule via scheduling.dependencies / scheduling.autoSchedule.",
      },
      {
        file: "calendars.html",
        title: "Working calendars",
        blurb:
          "Registry calendars, holidays and exception days driving non-working shading, working-day snapping and calendar-aware auto-scheduling via scheduling.calendars.",
      },
      {
        file: "critical-path.html",
        title: "Critical path",
        blurb:
          "Zero-float chain highlighting, near-critical banding and float reporting via scheduling.criticalPath.",
      },
      {
        file: "schedule-diagnostics.html",
        title: "Schedule diagnostics",
        blurb:
          "An unlinked-tasks / leads-and-lags schedule audit via scheduling.diagnostics's panel and the documented detection rules.",
      },
    ],
  },
  {
    category: "Resources & cost",
    pages: [
      {
        file: "resource.html",
        title: "Resource",
        blurb:
          "The merged opt-in resource plugin composed alongside presetStandard(): pool, assignment and utilization in one page.",
      },
      {
        file: "resources-load-chart.html",
        title: "Resource load chart and side panel",
        blurb:
          "Resource load histogram with capacity overload via resource.loadChart, plus the interaction.sidePanel inspector, its double-click edit dialog and the split / table / chart view modes.",
      },
      {
        file: "load-chart-config.html",
        title: "Load chart configuration",
        blurb:
          "The loadChart nest's bucket switcher, resources allowlist, axis/value labels and a custom load/capacity function pair.",
      },
      {
        file: "resource-assign.html",
        title: "Resource assignment",
        blurb:
          "Resource chips and assignment editing in the tree grid via resource.assign, paired with the scheduler's fixed-duration / fixed-work / fixed-units effort accounting.",
      },
      {
        file: "resource-view.html",
        title: "Resource view",
        blurb:
          "A read-only resource-axis timeline over the chart pane: per-resource rows with assignment segments and overallocation marking via resource.view.",
      },
      {
        file: "resource-utilization.html",
        title: "Resource utilization",
        blurb:
          "Pool ledger (capacities, calendars, time off, bookings) with day/week utilization buckets and over-allocation warnings via resource.utilization.",
      },
    ],
  },
  {
    category: "Portfolio & reporting",
    pages: [
      {
        file: "dashboard.html",
        title: "Dashboard",
        blurb:
          "Progress KPIs, overdue list with one-undo \"Mark done\", burndown and workload bars in an on-demand panel via portfolio({ dashboard }).",
      },
      {
        file: "portfolio.html",
        title: "Portfolio",
        blurb:
          "Multi-project hierarchy with health roll-up, goals and cross-project moves via the opt-in portfolio() plugin.",
      },
    ],
  },
  {
    category: "Data & sync",
    pages: [
      {
        file: "data-sync.html",
        title: "Data sync",
        blurb:
          "The merged opt-in dataSync plugin: StarGantt.localAdapter(seedDocument()) as an active source, with sync/* activity events.",
      },
      {
        file: "data-sources.html",
        title: "Data sources: REST, GraphQL and lazy loading",
        blurb:
          "Backend-backed charts on an in-page mock server: snapshot loads, delta sync, server-side filtering, optimistic write-back with rollback, and a paged backlog with streamed updates, via dataSync({ sources, graphql, lazyLoad }). No real server is contacted.",
      },
      {
        file: "offline-realtime.html",
        title: "Offline storage and realtime sync",
        blurb:
          "A second client's edits arrive over an in-page loopback socket while IndexedDB keeps the document across reloads, via dataSync({ offline, realtime }). No real server is contacted.",
      },
    ],
  },
  {
    category: "Import & export",
    pages: [
      {
        file: "export-range.html",
        title: "Export range (PNG/SVG)",
        blurb:
          "toPng/toSvg over the viewport/full/{start,end} range shapes via the stargantt.export facade, with the today-line and header band in the export.",
      },
      {
        file: "export-print.html",
        title: "Print and PDF export",
        blurb:
          "printPreview() wired to the browser's print dialog and multi-page toPdf() download via export.print.",
      },
      {
        file: "file-io.html",
        title: "File import and export",
        blurb:
          "CSV, project JSON and iCalendar in and out, Excel .xlsx export and MS Project XML import/export, all through the one stargantt.export facade.",
      },
      {
        file: "viewer-embed.html",
        title: "Viewer and embed",
        blurb:
          "Read-only viewing and shareable snapshot tokens via export.snapshot() / applySnapshot() and export.viewerEmbed.",
      },
    ],
  },
  {
    category: "Performance & dev tools",
    pages: [
      {
        file: "large-data-10k.html",
        title: "10,000-task performance test",
        blurb:
          "Virtual scrolling at 10k+ tasks, plus the view plugin's progressive / dirty-region / prefetch switches, dependency-line culling and the perfTools frame overlay.",
      },
    ],
  },
  ];

  var THEME_KEY = "stargantt-examples-theme";
  var doc = document;

  /** The file name of the page being viewed, e.g. `"basic-gantt.html"`. */
  function currentFile() {
    var parts = window.location.pathname.split("/");
    var last = parts[parts.length - 1];
    return last === "" ? "index.html" : last;
  }

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---------------------------------------------------------------- *
   * Colour scheme
   *
   * The stored choice overrides `prefers-color-scheme`; "auto" hands it back. The attribute goes
   * on <html> *and* on every chart root, because the theme plugin observes `data-theme` on the
   * chart root itself rather than on an ancestor — so the examples exercise that path on every
   * page rather than only on the theming demo.
   * ---------------------------------------------------------------- */

  function storedTheme() {
    try {
      return window.localStorage.getItem(THEME_KEY) || "auto";
    } catch (error) {
      return "auto"; // storage can be denied; the toggle then just does not persist
    }
  }

  function applyTheme(mode) {
    var root = doc.documentElement;
    if (mode === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    root.style.colorScheme = mode === "auto" ? "" : mode;
    syncChartRoots(mode);
  }

  /** Mirrors the scheme onto every mounted chart root so the view plugin's theme re-reads its tokens. */
  function syncChartRoots(mode) {
    var panes = doc.querySelectorAll(".sg-pane--chart");
    for (var i = 0; i < panes.length; i += 1) {
      // The view plugin's theme observes `data-theme` on the chart root itself, and wraps the
      // pane row in `.sg-pane-row`, so the chart pane's parent is the ROW, not the root —
      // stamping the row would restyle nothing the observer sees and the canvas would keep its
      // stale colours. Resolve the root deliberately: the row's parent when the row exists, the
      // pane's parent otherwise. (No v2 example page currently loads this script, so this
      // currently has nothing to do — see the file header — but stays correct if one does.)
      var parent = panes[i].parentElement;
      if (parent === null) continue;
      var chart = parent.classList.contains("sg-pane-row") ? parent.parentElement : parent;
      if (chart === null) continue;
      if (mode === "auto") chart.removeAttribute("data-theme");
      else chart.setAttribute("data-theme", mode);
    }
  }

  function setTheme(mode) {
    try {
      if (mode === "auto") window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, mode);
    } catch (error) {
      // ignore: the choice still applies for this page view
    }
    applyTheme(mode);
  }

  /* ---------------------------------------------------------------- *
   * Chrome
   * ---------------------------------------------------------------- */

  function buildTopBar() {
    var bar = el("header", "ex-topbar");

    var brand = el("a", "ex-brand");
    brand.href = "./index.html";
    brand.appendChild(el("span", "ex-brand-mark", "Star"));
    brand.appendChild(el("span", "ex-brand-accent", "Gantt"));
    bar.appendChild(brand);

    var search = el("input", "ex-search");
    search.type = "search";
    search.placeholder = "Search examples\u2026";
    search.setAttribute("aria-label", "Search examples");
    search.addEventListener("input", function () {
      filterSidebar(search.value);
    });
    bar.appendChild(search);

    bar.appendChild(el("span", "ex-topbar-spacer"));

    var toggle = el("button", "ex-theme-toggle");
    toggle.type = "button";
    var mode = storedTheme();
    function render() {
      toggle.textContent = mode === "auto" ? "Auto" : mode === "dark" ? "Dark" : "Light";
      toggle.setAttribute("aria-label", "Colour scheme: " + toggle.textContent);
    }
    toggle.addEventListener("click", function () {
      mode = mode === "auto" ? "light" : mode === "light" ? "dark" : "auto";
      setTheme(mode);
      render();
    });
    render();
    bar.appendChild(toggle);

    return bar;
  }

  function buildSidebar(file) {
    var nav = el("nav", "ex-sidebar");
    nav.setAttribute("aria-label", "Examples");
    for (var i = 0; i < CATALOG.length; i += 1) {
      var group = CATALOG[i];
      var section = el("div", "ex-nav-group");
      section.appendChild(el("div", "ex-nav-heading", group.category));
      for (var j = 0; j < group.pages.length; j += 1) {
        var page = group.pages[j];
        var link = el("a", "ex-nav-link", page.title);
        link.href = "./" + page.file;
        link.setAttribute("data-file", page.file);
        if (page.file === file) {
          link.classList.add("ex-nav-link--current");
          link.setAttribute("aria-current", "page");
        }
        section.appendChild(link);
      }
      nav.appendChild(section);
    }
    return nav;
  }

  /** Hides links (and then empty groups) that do not match `query`; empty query restores all. */
  function filterSidebar(query) {
    var needle = query.trim().toLowerCase();
    var groups = doc.querySelectorAll(".ex-nav-group");
    for (var i = 0; i < groups.length; i += 1) {
      var group = groups[i];
      var links = group.querySelectorAll(".ex-nav-link");
      var shown = 0;
      for (var j = 0; j < links.length; j += 1) {
        var link = links[j];
        var hit = needle === "" || (link.textContent || "").toLowerCase().indexOf(needle) !== -1;
        link.hidden = !hit;
        if (hit) shown += 1;
      }
      group.hidden = shown === 0;
    }
  }

  /** The index page's card grid, rendered from the same catalog the sidebar uses. */
  function buildIndexGrid() {
    var wrap = el("div", "ex-catalog");
    for (var i = 0; i < CATALOG.length; i += 1) {
      var group = CATALOG[i];
      var section = el("section", "ex-catalog-group");
      section.appendChild(el("h2", "ex-catalog-heading", group.category));
      var grid = el("div", "ex-card-grid");
      for (var j = 0; j < group.pages.length; j += 1) {
        var page = group.pages[j];
        var card = el("a", "ex-card");
        card.href = "./" + page.file;
        card.appendChild(el("span", "ex-card-title", page.title));
        card.appendChild(el("span", "ex-card-blurb", page.blurb));
        grid.appendChild(card);
      }
      section.appendChild(grid);
      wrap.appendChild(section);
    }
    return wrap;
  }

  /** The footer every demo page used to repeat verbatim. */
  function buildFooter() {
    var footer = el("footer", "ex-footer");
    footer.appendChild(
      doc.createTextNode("Each example page below loads only "),
    );
    footer.appendChild(el("code", "", "../packages/stargantt/dist/stargantt.iife.js"));
    footer.appendChild(
      doc.createTextNode(
        " (core + all fifteen official plugins + CSS) and boots the chart through the public API alone — no shared runtime chrome. ",
      ),
    );
    footer.appendChild(el("code", "", "datasets.js"));
    footer.appendChild(
      doc.createTextNode(" ships in this directory as a portable reference dataset library from the original example corpus but is not wired into any page."),
    );
    return footer;
  }

  /* ---------------------------------------------------------------- *
   * Mount
   *
   * The page's own markup is moved into a `.ex-main` column beside the sidebar, so the demo
   * pages need no per-page markup beyond loading this script.
   * ---------------------------------------------------------------- */

  function mount() {
    var file = currentFile();
    applyTheme(storedTheme());

    var body = doc.body;
    var main = el("main", "ex-main");
    while (body.firstChild !== null) main.appendChild(body.firstChild);

    var shell = el("div", "ex-shell");
    shell.appendChild(buildSidebar(file));
    shell.appendChild(main);

    // index.html owns its own <h1>/description in its markup (moved into `main` above along with
    // the rest of the page's body), so only the footer needs adding here.
    if (main.querySelector(".ex-footer") === null) {
      main.appendChild(buildFooter());
    }

    var topbar = buildTopBar();
    body.appendChild(topbar);
    body.appendChild(shell);
    body.classList.add("ex-has-shell");

    var slot = doc.getElementById("catalog");
    if (slot !== null) slot.appendChild(buildIndexGrid());
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mount);
  else mount();

  /** Test/debug hook: the catalog the sidebar and index render from. */
  window.__exCatalog = CATALOG;
})();
