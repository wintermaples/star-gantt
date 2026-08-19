// docs/specs/plugins/export.md §2, §9 (`internal/embed/`).
/**
 * The read-only / embed / snapshot area's slice of the facade.
 *
 * This area also owns the plugin's one standing footprint (§11): `guardFor` in `./guard` installs
 * the single `data/willApplyTransaction` subscription behind the read-only veto (§2.1) and the
 * import batch harvest (§1.5). `wireEmbed` is called once, synchronously, during `setup()` (from
 * `../../index.ts`), so everything below — the embed-mode dressing, the guard installation, the
 * `autoRestore` pass — runs exactly once per plugin instance.
 *
 * Divergence note (reported, not fixed — `index.ts` is out of this area's file scope): §2.2 says
 * `autoRestore` runs "once at `setup()` (after the service is provided)". `index.ts` builds the
 * `ExportService` object by spreading every area's `wire*(wiring)` result and calls `ctx.provide()`
 * only afterwards, so nothing in `wireEmbed` can run *after* that call without `index.ts` inserting
 * a post-provide hook of its own. `autoRestore` therefore runs at the end of `wireEmbed`, i.e.
 * before `ctx.provide` — functionally equivalent for every composed official plugin (`stargantt.export`
 * is Layer 8, the top layer, so nothing composed alongside it depends on the service being
 * reachable from inside an `autoRestore`-triggered `viewerembed/snapshotApplied` handler), but
 * technically a step earlier than the spec's wording. See the report for the (optional,
 * out-of-scope) `index.ts` patch that would close this exactly.
 */
import { DISPOSED_MESSAGE } from "../wiring";
import type { ExportWiring } from "../wiring";
import type { ExportService, SnapshotOptions } from "../../types";
import { EMBED_CLASS, embedStyleText } from "./embed";
import { guardFor } from "./guard";
import { buildSnapshotUrl, decodeSnapshot, encodeSnapshot, extractSnapshotToken } from "./snapshot";

/** The members `internal/embed/` owns. */
export type EmbedSurface = Pick<
  ExportService,
  "snapshot" | "applySnapshot" | "isReadOnly" | "setReadOnly"
>;

// Review m1 — mirrors the disposed-instance guard `../../index.ts`'s image path (`begin()`)
// already enforces; `ExportWiring.disposed()` had no caller in this area before this fix.
// Review m6 — `DISPOSED_MESSAGE` is `../wiring`'s, not a hand-copied literal.
export function wireEmbed(w: ExportWiring): EmbedSurface {
  const { ctx, config, data } = w;
  // Installs the shared subscription (idempotent — a no-op if `internal/formats/` already asked
  // for it) and applies the initial `sg-readonly` class per the resolved `viewerEmbed.readOnly`.
  const guard = guardFor(w);

  /* --- embed mode (§2.3) ------------------------------------------------- */
  if (config.viewerEmbed.embed) {
    ctx.root.classList.add(EMBED_CLASS);
    const style = ctx.root.ownerDocument.createElement("style");
    style.textContent = embedStyleText();
    ctx.root.appendChild(style);
    ctx.own({
      dispose: () => {
        style.remove();
        ctx.root.classList.remove(EMBED_CLASS);
      },
    });
  }

  /* --- snapshot tokens and URLs (§2.2) ------------------------------------ */
  // §7's `resolveConfig` only guarantees a non-`""` string here ("a non-empty string; defaults to
  // `sg-snapshot`" — the char-shape rule belongs to this area, §2.2). A parameter containing `&`,
  // `=`, or `#` would bleed across a URL delimiter (the fragment/query separator, or the value
  // separator itself), and a whitespace-only value reads as blank — both fall back the same way an
  // absent `snapshotParam` does.
  const configuredParam = config.viewerEmbed.snapshotParam;
  const param =
    configuredParam.trim() !== "" && !/[&=#]/.test(configuredParam) ? configuredParam : "sg-snapshot";

  // Reads the correct window for wherever this plugin is actually mounted — e.g. an iframe's own
  // window, not necessarily the top-level `window` — via the root element's own document.
  const currentHref = (): string => {
    const href = ctx.root.ownerDocument.defaultView?.location?.href;
    return typeof href === "string" ? href : "";
  };

  function restore(token: string, source: "api" | "url"): boolean {
    const decoded = decodeSnapshot(token);
    if (decoded === undefined) return false;
    data.load(decoded.data);
    ctx.emit("viewerembed/snapshotApplied", { source, droppedTasks: decoded.droppedTasks });
    return true;
  }

  function snapshot(options?: SnapshotOptions): string {
    if (w.disposed()) throw new Error(DISPOSED_MESSAGE);
    const token = encodeSnapshot(data.toJSON());
    const url = options !== null && typeof options === "object" ? options.url : undefined;
    if (url === true) return buildSnapshotUrl(currentHref(), param, token);
    if (typeof url === "string") {
      const base = url.trim() !== "" ? url : currentHref();
      return buildSnapshotUrl(base, param, token);
    }
    // `url` omitted, `false`, or an unusable value: the bare token.
    return token;
  }

  function applySnapshot(source?: string): boolean {
    if (w.disposed()) throw new Error(DISPOSED_MESSAGE);
    // When `source` is omitted, the current `location.href` is read as a URL.
    const target = source === undefined ? currentHref() : source;
    if (typeof target !== "string") return false;
    const fromUrl = extractSnapshotToken(target, param);
    if (fromUrl !== undefined) return restore(fromUrl, "url");
    // No `<param>=` in the target's fragment/query: when a source was given, treat it as the token
    // itself (an unpadded base64url token can never contain `<param>=`, so the two forms never
    // collide); when omitted and the page URL carried no parameter, there is nothing to restore.
    return source === undefined ? false : restore(source, "api");
  }

  const surface: EmbedSurface = {
    snapshot,
    applySnapshot,
    isReadOnly: () => {
      if (w.disposed()) throw new Error(DISPOSED_MESSAGE);
      return guard.isReadOnly();
    },
    setReadOnly: (on) => {
      if (w.disposed()) throw new Error(DISPOSED_MESSAGE);
      guard.setReadOnly(on);
    },
  };

  if (config.viewerEmbed.autoRestore) applySnapshot();

  return surface;
}
