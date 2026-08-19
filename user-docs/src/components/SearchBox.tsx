import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KIND_LABEL, prepare, search } from "../lib/search";
import type { SearchEntry, SearchHit } from "../lib/search";

/**
 * The site's search box.
 *
 * The index is fetched on first use, not on page load: it is a fifth of a megabyte of strings that
 * a reader who navigates by the sidebar never needs. Everything before that first keystroke is a
 * plain input with no behaviour attached.
 *
 * The pattern is ARIA 1.2's combobox-with-listbox: the input keeps focus and owns the keyboard,
 * `aria-activedescendant` moves the selection without moving focus, and the popup is labelled so a
 * screen reader announces the count as it changes. Arrow keys move, Enter navigates, Escape closes
 * (and closes to the input, not to nowhere), and `/` from anywhere that is not already a text field
 * puts the cursor here.
 */
export function SearchBox(): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<readonly SearchEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // One dynamic import, one chunk, one time. `loading` guards the double-fire a fast typist gets
  // from focus and the first keystroke landing in the same frame.
  const load = useCallback((): void => {
    if (entries !== null || loading) return;
    setLoading(true);
    void import("../generated/search-index.json")
      .then((module) => {
        setEntries((module.default as { entries: SearchEntry[] }).entries);
      })
      .finally(() => setLoading(false));
  }, [entries, loading]);

  const prepared = useMemo(() => (entries === null ? null : prepare(entries)), [entries]);
  const hits = useMemo<readonly SearchHit[]>(
    () => (prepared === null ? [] : search(prepared, query)),
    [prepared, query],
  );

  useEffect(() => setActive(0), [query]);

  // `/` is the shortcut every documentation site has, and the one place it must not fire is inside
  // a field where `/` is a character the reader meant to type — including the CodeMirror editors
  // the notebook cells mount, which are contenteditable rather than inputs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable === true) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A click anywhere else dismisses the popup. Pointerdown rather than click, so a click on a
  // result is not cancelled by the popup unmounting under the pointer first.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const go = (hit: SearchHit | undefined): void => {
    if (hit === undefined) return;
    window.location.hash = hit.entry.path;
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      if (query === "") inputRef.current?.blur();
      setOpen(false);
      setQuery("");
      return;
    }
    if (hits.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % hits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(hits[active]);
    }
  };

  const expanded = open && query !== "";
  const activeId = expanded && hits.length > 0 ? `search-hit-${active}` : undefined;

  return (
    <div className="search" ref={rootRef}>
      <input
        ref={inputRef}
        type="text"
        className="search-input"
        placeholder="Search   /"
        aria-label="Search the documentation"
        role="combobox"
        aria-expanded={expanded}
        aria-controls="search-results"
        aria-autocomplete="list"
        {...(activeId === undefined ? {} : { "aria-activedescendant": activeId })}
        value={query}
        onFocus={load}
        onChange={(event) => {
          load();
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />

      {expanded ? (
        <div className="search-pop">
          <ul id="search-results" role="listbox" aria-label="Search results" className="search-list">
            {hits.map((hit, index) => (
              <li
                key={hit.entry.path + hit.entry.title}
                id={`search-hit-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? "search-hit active" : "search-hit"}
                onPointerDown={(event) => {
                  event.preventDefault();
                  go(hit);
                }}
                onPointerEnter={() => setActive(index)}
              >
                <span className="search-kind">{KIND_LABEL[hit.entry.kind]}</span>
                <span className="search-body">
                  <span className="search-title">{hit.entry.title}</span>
                  <span className="search-context">{hit.entry.context}</span>
                  {hit.entry.text === "" ? null : (
                    <span className="search-text">{hit.entry.text}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div className="search-foot" role="status">
            {prepared === null
              ? "Loading the index…"
              : hits.length === 0
                ? `No match for “${query}”`
                : `${hits.length} result${hits.length === 1 ? "" : "s"} · ↑↓ to move, ⏎ to open`}
          </div>
        </div>
      ) : null}
    </div>
  );
}
