import { Shell } from "./components/Shell";
import {
  CORE,
  GUIDES,
  isDocumented,
  loadCore,
  loadGuide,
  loadPluginDoc,
  loadTokensDoc,
  routes,
} from "./content/registry";
import type { CoreDoc, GuideDoc, PluginDoc, TokensDoc } from "./content/types";
import { PLUGINS, shortName } from "./generated/api";
import { href, useRoute } from "./lib/router";
import { useAsync } from "./lib/useAsync";
import type { Async } from "./lib/useAsync";
import { CorePage } from "./pages/CorePage";
import { GuidePage } from "./pages/GuidePage";
import { Home } from "./pages/Home";
import { PluginConfigPage } from "./pages/PluginConfigPage";
import { PluginPage } from "./pages/PluginPage";
import { TokensPage } from "./pages/TokensPage";

/**
 * Routing is derived from the same manifest the sidebar uses, so a page cannot exist without a
 * link to it and a link cannot exist without a page behind it. The only 404 the site can produce
 * is for a plugin that has no content module yet, and that one says so by name.
 *
 * A page's content module is fetched when the route reaches it, never before — which is why the
 * page components below are rendered by a small resolver rather than directly.
 */
export function App(): React.JSX.Element {
  const route = useRoute();
  return <Shell route={route}>{renderRoute(route)}</Shell>;
}

function renderRoute(route: string): React.JSX.Element {
  if (route === routes.home()) return <Home />;

  const core = /^\/core\/([^/]+)$/.exec(route);
  if (core) return <CoreRoute route={route} slug={core[1]!} />;

  const guide = /^\/guides\/([^/]+)$/.exec(route);
  if (guide) return <GuideRoute route={route} slug={guide[1]!} />;

  if (route === routes.tokens()) return <TokensRoute route={route} />;

  const reference = /^\/reference\/([^/]+)(\/config)?$/.exec(route);
  if (reference) {
    const name = reference[1]!;
    const plugin = PLUGINS.find((p) => shortName(p.id) === name);
    if (!plugin) return <Missing what={`Plugin "${name}"`} known={[]} />;
    if (!isDocumented(plugin.id)) return <Undocumented id={plugin.id} />;
    return <PluginRoute route={route} id={plugin.id} config={reference[2] !== undefined} />;
  }

  return <Missing what={route} known={[routes.home()]} />;
}

function CoreRoute({ route, slug }: { route: string; slug: string }): React.JSX.Element {
  const doc = useAsync<CoreDoc | undefined>(route, () => loadCore(slug));
  return (
    <Resolved
      state={doc}
      missing={<Missing what={`Core chapter "${slug}"`} known={CORE.map((p) => routes.core(p.slug))} />}
      render={(value) => <CorePage doc={value} />}
    />
  );
}

function GuideRoute({ route, slug }: { route: string; slug: string }): React.JSX.Element {
  const doc = useAsync<GuideDoc | undefined>(route, () => loadGuide(slug));
  return (
    <Resolved
      state={doc}
      missing={<Missing what={`Guide "${slug}"`} known={GUIDES.map((p) => routes.guide(p.slug))} />}
      render={(value) => <GuidePage doc={value} />}
    />
  );
}

function TokensRoute({ route }: { route: string }): React.JSX.Element {
  const doc = useAsync<TokensDoc | undefined>(route, () => loadTokensDoc());
  return (
    <Resolved
      state={doc}
      missing={<Missing what="The token reference" known={[routes.tokens()]} />}
      render={(value) => <TokensPage doc={value} />}
    />
  );
}

function PluginRoute({
  route,
  id,
  config,
}: {
  route: string;
  id: string;
  config: boolean;
}): React.JSX.Element {
  const doc = useAsync<PluginDoc | undefined>(route, () => loadPluginDoc(id));
  return (
    <Resolved
      state={doc}
      missing={<Undocumented id={id} />}
      render={(value) => (config ? <PluginConfigPage doc={value} /> : <PluginPage doc={value} />)}
    />
  );
}

/**
 * Renders one of the four outcomes of a content fetch.
 *
 * The loading state is deliberately a bare placeholder with no spinner: a same-origin chunk lands
 * in a few milliseconds on a warm cache, and a spinner that flashes for one frame reads as jank.
 */
function Resolved<T>({
  state,
  missing,
  render,
}: {
  state: Async<T | undefined>;
  missing: React.JSX.Element;
  render: (value: T) => React.JSX.Element;
}): React.JSX.Element {
  if (state.status === "loading") return <div className="page" data-loading="true" />;
  if (state.status === "failed") {
    return (
      <div className="page">
        <div className="callout err">This page could not be loaded — {state.error}</div>
      </div>
    );
  }
  return state.value === undefined ? missing : render(state.value);
}

function Undocumented({ id }: { id: string }): React.JSX.Element {
  return (
    <div className="page">
      <h1 style={{ fontSize: 20 }}>{id} is not documented yet</h1>
      <p className="lede">
        The plugin exists and is in the API snapshot, but no page has been written for it. This is
        documentation debt, not a broken link — the sidebar marks it <code>todo</code> for the same
        reason.
      </p>
      <p>
        <a href={href(routes.home())}>Back to the overview</a>
      </p>
    </div>
  );
}

function Missing({ what, known }: { what: string; known: readonly string[] }): React.JSX.Element {
  return (
    <div className="page">
      <h1 style={{ fontSize: 20 }}>No such page</h1>
      <p className="lede">
        <code>{what}</code> does not exist on this site.
      </p>
      {known.length > 0 ? (
        <p>
          Try:{" "}
          {known.slice(0, 6).map((route, i) => (
            <span key={route}>
              {i > 0 ? " · " : ""}
              <a href={href(route)}>{route}</a>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
