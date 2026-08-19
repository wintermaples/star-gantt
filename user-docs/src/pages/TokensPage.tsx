import { useEffect, useMemo, useRef, useState } from "react";
import { RichParagraph, RichText } from "../components/RichText";
import { StaticCode } from "../components/StaticCode";
import type { TokensDoc } from "../content/types";
import { CANVAS_READ_COUNT, TOKENS, tokensOf } from "../generated/tokens";
import type { TokenDoc } from "../generated/tokens";
import { currentQuery } from "../lib/router";

/**
 * The CSS token reference: every `--sg-*` the library has, on one page.
 *
 * One page rather than one per family, and no pagination, because the question this page answers is
 * "is there a token for this?" — and the only answer a reader can trust is one they can search the
 * whole of. That is also why the filter box narrows the page in place instead of navigating: the
 * count under it is the answer to "how many are there", and an empty result is a real answer rather
 * than a 404.
 *
 * Colour is never the only carrier here. A swatch always sits beside the value it paints, the
 * canvas and forced-colours facts are words rather than tints, and the two schemes are two labelled
 * columns rather than one square a reader has to switch themes to see.
 */
export function TokensPage({ doc }: { doc: TokensDoc }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const prose = useMemo(() => new Map(doc.groups.map((group) => [group.id, group])), [doc]);

  const needle = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      TOKENS.groups
        .map((group) => ({ group, tokens: tokensOf(group).filter((token) => matches(token, needle)) }))
        .filter((entry) => entry.tokens.length > 0),
    [needle],
  );
  const shown = groups.reduce((total, entry) => total + entry.tokens.length, 0);

  // `?t=--sg-bar-fill` — where a search hit for a token name lands. It runs on mount and on every
  // hash change, because a hit for another token on the page the reader is already looking at
  // changes the query without changing the route, so this component is never remounted.
  useEffect(() => {
    const jump = (): void => {
      const target = currentQuery().get("t");
      if (target === null) return;
      const row = bodyRef.current?.querySelector<HTMLElement>(`[data-token="${CSS.escape(target)}"]`);
      row?.scrollIntoView({ block: "center" });
    };
    jump();
    window.addEventListener("hashchange", jump);
    return () => window.removeEventListener("hashchange", jump);
  }, []);

  const highlighted = typeof window === "undefined" ? null : currentQuery().get("t");

  return (
    <div className="page">
      <div className="crumb">reference</div>
      <h1>{doc.title}</h1>
      <p className="lede">
        <RichText>{doc.lede}</RichText>
      </p>

      {doc.sections.map((section) => (
        <section key={section.heading} className="token-section">
          <h2 id={slug(section.heading)}>{section.heading}</h2>
          {section.paragraphs.map((paragraph, i) => (
            <RichParagraph key={i}>{paragraph}</RichParagraph>
          ))}
          {section.code ? (
            <StaticCode source={section.code.source} language={section.code.label === "css" ? "css" : "ts"} />
          ) : null}
        </section>
      ))}

      <hr className="section-rule" />

      <h2 id="every-token">Every token</h2>
      <p>
        {TOKENS.tokens.length} tokens, {CANVAS_READ_COUNT} of them read by the canvas. Grouped by the
        part of the chart they paint.
      </p>

      <div className="token-toolbar">
        <label className="token-filter">
          <span className="sr-only">Filter tokens by name or description</span>
          <input
            type="search"
            value={query}
            placeholder="Filter — bar, font, header…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="token-count" role="status">
          {shown === TOKENS.tokens.length ? `${shown} tokens` : `${shown} of ${TOKENS.tokens.length} tokens`}
        </span>
      </div>

      {needle === "" ? (
        <nav className="token-jump" aria-label="Token groups">
          {TOKENS.groups.map((group) => (
            <a key={group.id} href={`#/tokens`} onClick={jumpTo(group.id)}>
              {prose.get(group.id)?.title ?? group.id}
            </a>
          ))}
        </nav>
      ) : null}

      <div ref={bodyRef}>
        {groups.map(({ group, tokens }) => (
          <section key={group.id} className="token-group" id={`group-${group.id}`}>
            <h3>{prose.get(group.id)?.title ?? group.id}</h3>
            {prose.get(group.id) ? <RichParagraph>{prose.get(group.id)!.prose}</RichParagraph> : null}
            {/* The table is five columns of mostly monospace text and cannot usefully narrow past
                the minimum viewport, so it scrolls inside its own box rather than pushing the
                prose column sideways with it. */}
            <div className="token-scroll">
              <TokenTable tokens={tokens} highlighted={highlighted} />
            </div>
          </section>
        ))}
        {groups.length === 0 ? (
          <p className="token-empty">
            No token matches <code>{query.trim()}</code>. Every token the library has is on this page,
            so a name that finds nothing here is one it does not declare.
          </p>
        ) : null}
      </div>

      <hr className="section-rule" />

      <h2 id="derived">Derived properties</h2>
      <RichParagraph>{doc.appendix.derived}</RichParagraph>
      <table className="api-table">
        <thead>
          <tr>
            <th>Property</th>
            <th>Declared as</th>
          </tr>
        </thead>
        <tbody>
          {TOKENS.derived.map((token) => (
            <tr key={token.name}>
              <td className="mono">{token.name}</td>
              <td className="mono">{token.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 id="published">Published by the chart</h2>
      <RichParagraph>{doc.appendix.published}</RichParagraph>
      <table className="api-table">
        <thead>
          <tr>
            <th>Property</th>
          </tr>
        </thead>
        <tbody>
          {TOKENS.published.map((token) => (
            <tr key={token.name}>
              <td className="mono">{token.name}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 id="retired">Retired names</h2>
      <RichParagraph>{doc.appendix.retired}</RichParagraph>
      <table className="api-table">
        <thead>
          <tr>
            <th>Property</th>
            <th>What to write instead</th>
          </tr>
        </thead>
        <tbody>
          {TOKENS.retired.map((token) => (
            <tr key={token.name}>
              <td className="mono">{token.name}</td>
              <td className="desc">
                <RichText>{token.advice}</RichText>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TokenTable({
  tokens,
  highlighted,
}: {
  tokens: readonly TokenDoc[];
  highlighted: string | null;
}): React.JSX.Element {
  return (
    <table className="api-table token-table">
      <thead>
        <tr>
          <th>Token</th>
          <th>Light</th>
          <th>Dark</th>
          <th>Read</th>
          <th>What it is</th>
        </tr>
      </thead>
      <tbody>
        {tokens.map((token) => (
          <tr
            key={token.name}
            data-token={token.name}
            {...(highlighted === token.name ? { "aria-current": "true" as const } : {})}
          >
            <td className="mono">{token.name}</td>
            <td className="mono value">
              <Value token={token} scheme="light" />
            </td>
            <td className="mono value">
              {token.dark === null ? <span className="token-same">same</span> : <Value token={token} scheme="dark" />}
            </td>
            <td className="token-where">
              {token.canvasRead ? <span className="pill type">canvas</span> : <span className="pill type">css</span>}
              {token.forcedColor ? <span className="token-forced">{token.forcedColor}</span> : null}
            </td>
            <td className="desc">
              {token.note ? <RichText>{token.note}</RichText> : <span className="token-same">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * One value, with a swatch when the value is a colour.
 *
 * The swatch is painted with the literal value rather than with the token, so both schemes are
 * visible whichever one the reader is in — a square showing `var(--sg-bar-fill)` would show the
 * dark column's colour only to a reader already in dark mode, which is the one reader who does not
 * need to be told. It carries a border because half of these values are near-white or near-black
 * and would otherwise dissolve into the row.
 */
function Value({ token, scheme }: { token: TokenDoc; scheme: "light" | "dark" }): React.JSX.Element {
  const value = scheme === "dark" ? (token.dark ?? token.light) : token.light;
  return (
    <span className="token-value">
      {token.kind === "color" ? <span className="token-swatch" style={{ background: value }} aria-hidden="true" /> : null}
      <span>{value}</span>
    </span>
  );
}

/** Whether a token survives the filter: its name, its note, or the plugins that read it. */
function matches(token: TokenDoc, needle: string): boolean {
  if (needle === "") return true;
  const haystack = `${token.name} ${token.note} ${token.readers.join(" ")} ${token.group}`.toLowerCase();
  return needle.split(/\s+/).every((term) => haystack.includes(term));
}

/**
 * Scrolls a group into view without pushing a history entry.
 *
 * The site is a hash router, so an `href="#group-x"` would be read as a route rather than as an
 * anchor and would navigate away from the page. The link keeps a real `href` so it is a link — a
 * tab stop, focusable, with a pointer cursor — and the handler does what the fragment would have.
 */
function jumpTo(id: string): (event: React.MouseEvent) => void {
  return (event) => {
    event.preventDefault();
    document.getElementById(`group-${id}`)?.scrollIntoView({ block: "start" });
  };
}

const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
