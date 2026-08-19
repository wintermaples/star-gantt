/**
 * `expectDepsConsistency` — the mechanical `dependsOn` / `ctx.use()` consistency check every
 * official plugin's test suite runs (`architecture.md` chapter 7).
 *
 * It runs `plugin.setup()` once against a fully permissive mock `PluginContext` (no real core, no
 * sibling plugins — "run init in a mock environment and record use", as opposed to
 * `createTestHost`'s real core): every `use()` call is recorded and answered with a harmless stub
 * value so `setup()` can run to completion even for services the plugin only partially interacts
 * with; `useOptional()` calls are answered `undefined` (a real, legal outcome for an optional
 * lookup) and are not part of the comparison, matching "non-optional `ctx.use`" in the module's
 * public description.
 *
 * `PluginMeta.dependsOn` and `ctx.use()` draw from two different identifier spaces in the real
 * core — `dependsOn` names *provider plugin ids* (`services.ts`'s `_declared()` check), while
 * `ctx.use()` takes *service ids*, which are not required to match their provider's plugin id
 * (`architecture.md` §4.1: `stargantt.data-store` provides both `data` and `fields`).
 * `@stargantt/core`'s public surface exposes no way to map a service id back to its provider's
 * plugin id at runtime (no back-door API, per chapter 8), so `expectDepsConsistency` cannot derive
 * that mapping itself; the caller supplies it instead, via the optional `serviceProviders`
 * parameter (service id → provider plugin id, e.g. an inline literal of the relevant `architecture.md`
 * §4.1 row for an official plugin's test, or a third party's own map). When given, every recorded
 * key is translated through it (an id absent from the map passes through unchanged) before the
 * comparison, so multiple services from the same provider collapse to that one `dependsOn` entry.
 * Without it, the comparison is the literal one: declared `dependsOn` entries against the raw
 * `ctx.use()` key strings, exact only when a plugin's `ctx.use()` keys are themselves the tokens
 * listed in `dependsOn`.
 */
import type { AnyPlugin, Disposable, PluginContext } from "@stargantt/core";
import { headlessElement } from "./element";

/**
 * Asserts that `plugin`'s declared hard dependencies (`meta.dependsOn`) exactly match the set of
 * providers implied by its `ctx.use()` calls (non-optional) during `setup()`. Throws, listing both
 * directions of the mismatch, when they differ; returns normally when they match.
 *
 * Without `serviceProviders`, each `ctx.use()` key is compared to `dependsOn` as-is. With it, each
 * key is first translated to its provider plugin id (service id → provider plugin id; an
 * untranslated id passes through unchanged) and the resulting, deduplicated set is compared.
 */
export function expectDepsConsistency(
  plugin: AnyPlugin,
  serviceProviders?: Record<string, string>,
): void {
  const used = new Set<string>();
  const ctx = recordingContext(used);
  plugin.setup(ctx, undefined);

  const providers = new Set([...used].map((k) => serviceProviders?.[k] ?? k));

  const declared = new Set(plugin.meta.dependsOn ?? []);
  const undeclared = [...providers].filter((k) => !declared.has(k)).sort();
  const unused = [...declared].filter((k) => !providers.has(k)).sort();
  if (undeclared.length === 0 && unused.length === 0) return;

  const lines = [`expectDepsConsistency("${plugin.meta.id}"): dependsOn does not match ctx.use()`];
  if (undeclared.length > 0) lines.push(`  used but not declared: ${undeclared.join(", ")}`);
  if (unused.length > 0) lines.push(`  declared but not used: ${unused.join(", ")}`);
  throw new Error(lines.join("\n"));
}

/**
 * A never-throwing `PluginContext` double: every call is a recorded no-op, `use()` returns a stub.
 *
 * `defineExtensionPoint`/`contribute` are the one pair that isn't inert: `contribute(key, value)`
 * records `value` (in call order) into a map keyed by `key`, and an extension point the plugin
 * itself defines via `defineExtensionPoint(key, reduce)` resolves `reduce` over whatever is
 * recorded for `key` at the moment `.get()` is called. This lets a plugin that both contributes to
 * and reads back its own extension point during `setup()` (seeding a store from its own
 * self-defined point, for instance) run to completion instead of always seeing an empty array —
 * the real core's own three strategies (`collect`/`first`/`reduce`, `core/index.ts`) are ordinary
 * `(inputs) => result` functions, so this needs no strategy-specific casework here. A `contribute`
 * to a point never defined in this same mock run stays recorded but inert, exactly as before —
 * nothing here ever reads it.
 */
function recordingContext(used: Set<string>): PluginContext {
  const contributions = new Map<string, unknown[]>();
  return {
    provide(): void {},
    use(key: string): unknown {
      used.add(key);
      return harmlessStub();
    },
    useOptional(): undefined {
      return undefined;
    },
    defineExtensionPoint(key: string, reduce: (inputs: never[]) => unknown): unknown {
      return { key, get: () => reduce((contributions.get(key) ?? []) as never[]) };
    },
    contribute(key: string, value: unknown): void {
      const list = contributions.get(key);
      if (list === undefined) contributions.set(key, [value]);
      else list.push(value);
    },
    on(): Disposable {
      return { dispose(): void {} };
    },
    emit(): void {},
    registerCommand(): void {},
    dispatch(): void {},
    claimOrder(): void {},
    claimKey(): void {},
    claimSlot(): { granted: boolean } {
      return { granted: true };
    },
    // A plugin's own teardown (the function `setup()` may return) is never captured here — this
    // function only calls `plugin.setup(ctx, undefined)` directly and discards its return value.
    // `own()` itself is a pure no-op: nothing is ever released. Both are fine, on purpose — this
    // context lives only for the length of one `expectDepsConsistency()` call, in the test
    // process; nothing it "owns" is a real resource (DOM node, timer, subscription), so leaving
    // it all unreleased is not a leak in any sense that matters here.
    own(): void {},
    root: headlessElement(),
    locale: "en",
  } as unknown as PluginContext;
}

/**
 * An inert value safe to call, index, coerce or chain off of arbitrarily: every property access
 * and every call returns the same stub again, and coercion to a primitive (a template literal, `+`,
 * `Number(...)`, `` String(...) ``, and the like) answers `""` / `0` instead of throwing. Stands in
 * for `ctx.use()`'s return value so plugin `setup()` code that immediately calls into, reads a
 * property of, or coerces the "service" (`ctx.use("x").state.subscribe(fn)`, `` `${ctx.use("x")}` ``,
 * and the like) does not crash before the key has been recorded.
 */
function harmlessStub(): unknown {
  const fn = (): unknown => stub;
  const stub: unknown = new Proxy(fn, {
    get: (_target, p) =>
      p === Symbol.toPrimitive ? (hint: string): string | number => (hint === "string" ? "" : 0) : stub,
    apply: () => stub,
  });
  return stub;
}
