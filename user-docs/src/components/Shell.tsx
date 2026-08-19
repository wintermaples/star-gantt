import { CATEGORY_ORDER, PLUGINS, pluginsByCategory, shortName } from "../generated/api";
import { CORE, GUIDES, TOKENS_PAGE, isDocumented, routes } from "../content/registry";
import { href } from "../lib/router";
import { SearchBox } from "./SearchBox";
import { ThemeToggle } from "./ThemeToggle";

interface NavRow {
  label: string;
  route?: string | undefined;
  title?: boolean | undefined;
  missing?: boolean | undefined;
}

/**
 * The sidebar is derived, never typed by hand: one row per core chapter, per guide, and per plugin
 * in `api.json`. A plugin whose content module does not exist yet still gets its row, marked
 * `todo` — a reader must be able to see what the site owes them, and a hole must be impossible to
 * hide by simply not linking to it.
 */
function buildNav(): readonly NavRow[] {
  const rows: NavRow[] = [{ label: "Getting started", title: true }, { label: "Overview", route: routes.home() }];

  if (CORE.length > 0) {
    rows.push({ label: "Core concepts", title: true });
    for (const page of CORE) rows.push({ label: page.title, route: routes.core(page.slug) });
  }
  if (GUIDES.length > 0) {
    rows.push({ label: "Guides", title: true });
    for (const page of GUIDES) rows.push({ label: page.title, route: routes.guide(page.slug) });
  }
  // Its own heading rather than a row under Reference: the token list is not a plugin, and a
  // reader looking for "how do I change the colours" is not looking under a plugin's name.
  rows.push({ label: "Theming", title: true });
  rows.push({ label: TOKENS_PAGE.title, route: routes.tokens() });

  for (const category of CATEGORY_ORDER) {
    const plugins = pluginsByCategory(category);
    if (plugins.length === 0) continue;
    rows.push({ label: `Reference · ${category}`, title: true });
    for (const plugin of plugins) {
      const documented = isDocumented(plugin.id);
      rows.push({
        label: shortName(plugin.id),
        route: documented ? routes.plugin(plugin.id) : undefined,
        missing: !documented,
      });
    }
  }
  return rows;
}

const TOP_LINKS = [
  { label: "Overview", match: (r: string) => r === "/", route: "/" },
  { label: "Core", match: (r: string) => r.startsWith("/core"), route: () => routes.core(CORE[0]?.slug ?? "") },
  { label: "Guides", match: (r: string) => r.startsWith("/guides"), route: () => routes.guide(GUIDES[0]?.slug ?? "") },
  {
    label: "Reference",
    match: (r: string) => r.startsWith("/reference"),
    route: () => routes.plugin(PLUGINS[0]?.id ?? ""),
  },
  { label: TOKENS_PAGE.title, match: (r: string) => r.startsWith("/tokens"), route: routes.tokens() },
] as const;

export function Shell({ route, children }: { route: string; children: React.ReactNode }): React.JSX.Element {
  const nav = buildNav();

  return (
    <div className="shell">
      {/*
       * The first focusable element of every page. A chart uses a roving tabindex — Tab enters and
       * leaves the widget, the arrows move between rows — which is the ARIA treegrid pattern, but
       * it only reads as working if the chart is reachable: measured here, the top bar and the
       * sidebar put 90 stops in front of it. Sends focus to the first chart's focused row.
       */}
      <a
        className="skip-link"
        href="#chart"
        onClick={(event) => {
          const row = document.querySelector<HTMLElement>(
            '[role="treegrid"] [role="row"][tabindex="0"]',
          );
          if (row === null) return;
          event.preventDefault();
          row.focus();
        }}
      >
        Skip to the chart
      </a>
      <header className="topbar">
        <a className="brand" href={href(routes.home())}>
          <span className="dot" />
          StarGantt
        </a>
        <nav aria-label="Sections">
          {TOP_LINKS.map((link) => {
            const target = typeof link.route === "function" ? link.route() : link.route;
            if (!target || target.endsWith("/")) return null;
            return (
              <a key={link.label} href={href(target)} aria-current={link.match(route) ? "page" : undefined}>
                {link.label}
              </a>
            );
          })}
        </nav>
        <span className="spacer" />
        <SearchBox />
        <ThemeToggle />
      </header>

      <div className="body">
        <aside className="sidenav">
          <nav aria-label="Documentation">
            {nav.map((row, i) =>
              row.title ? (
                <div className="nav-title" key={`t${i}`}>
                  {row.label}
                </div>
              ) : row.route ? (
                <a
                  key={row.route}
                  className="nav-link"
                  href={href(row.route)}
                  aria-current={route === row.route || route === `${row.route}/config` ? "page" : undefined}
                >
                  <span>{row.label}</span>
                </a>
              ) : (
                <span key={`${row.label}${i}`} className="nav-link missing" title="Not documented yet">
                  <span>{row.label}</span>
                  <span className="tag">todo</span>
                </span>
              ),
            )}
          </nav>
        </aside>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
