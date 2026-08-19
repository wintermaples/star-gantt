import type { CoreDoc } from "../types";

/**
 * How plugins find each other. The registry has no concept of a gantt chart either — it is a
 * typed map from string key to whatever a plugin decided to put there, plus one rule about when a
 * lookup is allowed to succeed.
 */
const doc: CoreDoc = {
  slug: "service-registry",
  title: "The service registry",
  lede: "Plugins import each other's types, and never each other's values. A capability is published under a key with ctx.provide, and any plugin that declared a dependency on the provider fetches it back with ctx.use — typed, synchronous, and guaranteed to already exist. That lookup is the only runtime channel between two plugins.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "Plugins do import each other's modules — that is how tree-grid's own conditional-format rule engine pulls in task-bars' BarStyleProvider type to shape its taskbars/style contribution, a type-only import across an upward layer edge — but never each other's values: nothing imports another plugin's factory, calls it, or reaches into its state. The only runtime channel between two plugins is the registry. The only way task-bars gets at the task list is by asking the registry for it, and the only way data-store answers is by having published it there first.",
        "ctx.provide(key, impl) is a plain set. Whatever you pass — an object of methods, a class instance, a function — comes back byte-identical from ctx.use(key). The registry does not wrap it, clone it or validate its shape; the type is the only contract, and the type comes from the key.",
        "That byte-identical rule is also why the registry did not have to change shape when many services grew a store: a Store is just another property on the object you passed to provide(), so ctx.use(key).someStore is the same lookup it always was. The registry has no idea some of what it hands back is store-shaped, and does not need to — get() and subscribe() are the store's own contract (the lifecycle-and-ownership and event-bus chapters cover it), not a registry feature.",
      ],
    },
    {
      kind: "code",
      caption: "data-store publishes the one service almost everything else in the preset depends on.",
      source: `const dataStore = StarGantt.definePlugin({
  meta: { id: "stargantt.data-store", dependsOn: [] },
  setup(ctx) {
    const service = createDataService(/* ... */);
    ctx.provide("stargantt.data", service);
  },
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "Keys are strings at runtime, but a reader never types one out and hopes. Every official service key exists because some plugin's .d.ts has a `declare module \"@stargantt/core\" { interface Services { ... } }` block that merges its key into the global Services interface — the same trick the Events, Commands and ExtensionPoints surfaces use. ctx.provide, ctx.use and ctx.useOptional are all generic over `keyof Services`, so the string you type and the type you get back are the same declaration; there is no separate registration step to keep in sync by hand.",
        "Do not confuse that key with the plugin id. \"stargantt.data-store\" (the plugin id, used in meta.id and dependsOn) and \"stargantt.data\" (the service key, used in provide()/use()) are two different strings on two different plugins' worth of business, and nothing forces them to look alike — the code sample above uses one of each. dependsOn and meta.optional always list provider plugin ids; provide(), use() and useOptional() always take service keys. Write a dependsOn entry with a service key in it and the host will not find the plugin it names.",
        "That merging is also why the core file itself declares Services as an empty interface. It ships no domain keys because it has no domain — \"stargantt.data\", \"stargantt.view\", \"stargantt.selection\" are additions from the plugins that provide them, visible to TypeScript only once that plugin's module has been imported somewhere in the program.",
      ],
    },
    {
      kind: "code",
      caption: "The registration a plugin's own module carries, next to the setup() that calls provide().",
      source: `declare module "@stargantt/core" {
  interface Services {
    "stargantt.data": DataService;
  }
}`,
    },
    {
      kind: "prose",
      paragraphs: [
        "ctx.use throws two different errors, and the difference matters when you are debugging a startup failure. `service \"X\" is not provided` means no plugin in this composition ever called provide() for that key — you forgot the plugin, or you left it out of the array on purpose and the dependent plugin still expects it. `plugin \"Y\" used service \"X\" provided by \"Z\", which is not in its dependsOn` means the provider Z exists and did provide it, but the consumer Y never declared a dependsOn edge on Z — the `provided by \"Z\"` clause is what tells you which plugin id belongs in your dependsOn array — copy that id, do not assume it matches the service key. Sometimes it does not (`stargantt.data` is provided by `stargantt.data-store`); sometimes it does (`stargantt.perf-tools` is provided by the plugin of the same name, as cell 8 below uses). The clause is the source of truth either way.",
        "That second error is not a formality. dependsOn is what the host's topological sort reads to decide start order (see the plugin host chapter), so a service lookup with no dependsOn entry backing it is a lookup with no ordering guarantee behind it — it might work today because the provider happens to start first, and break the day someone reorders the preset array. The registry refuses the call outright rather than let that race exist silently. A third, unrelated startup error — a dependency cycle — does carry the offending plugin-id chain in its message; a missing dependency does not.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "Because dependsOn is resolved before any dependent's setup() runs, ctx.use() inside setup() never returns null and never needs a guard. The host builds the start order as a topological sort of the whole dependsOn graph first, then walks it calling setup() in that order — by the time your setup() runs, every plugin you declared a hard dependency on has already run its own setup() and had the chance to provide() whatever it owns. A dependsOn entry naming a plugin id that was never registered is a startup error too (`plugin \"X\" depends on unregistered plugin \"Y\"`), not a blank chart discovered at scroll time.",
        "That is the trade the design makes deliberately: a composition mistake — a plugin dropped from the array, a dependsOn entry left off — surfaces once, loudly, when the chart is built. It costs you having to declare dependencies you might only call once, in exchange for never having to write `if (!service) return` in a render loop.",
      ],
    },
    {
      kind: "demo",
      caption: "presetStandard() — task-bars uses stargantt.data, resolved before it ever paints a bar.",
      spec: { preset: { treeGrid: { paneWidth: 200 } } },
    },
    {
      kind: "prose",
      paragraphs: [
        "useOptional is the other lookup, and it exists for a real asymmetry: some plugins are enhancements that should render as if they were not installed at all when a companion is missing, rather than fail the whole chart's startup. A badge plugin that adds one extra line of content when the perf-tools plugin is present has no error to raise if it is not — perf-tools ships in the bundle but never in presetStandard() (it is one of the six opt-in plugins), so most compositions genuinely do not have it, and the badge just has less to show.",
        "The catch is a rule the contract states plainly and worth repeating here: meta.optional is a lookup allowlist, not an ordering edge. dependsOn changes the start order; optional does not. A call to useOptional made inside setup() can run before the soft dependency's own setup() has had a chance to call provide(), and get undefined even though that plugin is very much part of the composition — it just has not started yet. The fix is never to latch a setup()-time undefined as \"this feature is unavailable\"; re-resolve the lookup at first actual use, or wait for the lifecycle/ready event that fires once every plugin's setup() has completed, and treat that as the earliest point an optional service's absence is meaningful.",
        "There is a second, quieter way useOptional() returns undefined forever: if the provider's plugin id is missing from meta.optional (and from dependsOn) altogether, getOptional() treats the lookup as undeclared and hands back undefined on every call, at any time, whether or not the provider is composed and running. Unlike use(), nothing throws — a forgotten optional entry looks identical to a genuinely absent companion plugin, so if a soft dependency you know is installed never shows up, check the meta.optional array before you suspect start order.",
      ],
    },
    {
      kind: "code",
      caption: "Re-resolving instead of latching a setup()-time null.",
      source: `const perfBadge = StarGantt.definePlugin({
  meta: {
    id: "acme.perf-badge",
    dependsOn: ["stargantt.data-store"],
    optional: ["stargantt.perf-tools"],
  },
  setup(ctx) {
    // Wrong: this can read undefined even when perf-tools IS composed, just because
    // it has not run its own setup() yet.
    // const perf = ctx.useOptional("stargantt.perf-tools");

    ctx.on("lifecycle/ready", () => {
      const perf = ctx.useOptional("stargantt.perf-tools");
      if (!perf) return; // genuinely absent — degrade quietly, no error
      // ...use it
    });
  },
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "A third-party plugin claims a key exactly the way an official one does: pick a string that will not collide, and merge it into Services yourself. The convention the official plugins follow is a reverse-namespaced prefix — \"stargantt.*\" is reserved for the library itself, so your own plugins should use something else, such as your package or organisation name (\"acme.row-counter\", as the plugin-host chapter's example plugin does). Nothing enforces the prefix at runtime; the registry is a flat string-keyed map, and two plugins that provide() the same key silently overwrite one another in start order — the last plugin to run its setup() wins — with no warning. The convention is the only collision defense there is, which is exactly why the reserved prefix exists.",
        "This is also why declaring a service key costs nothing extra beyond the merge block: there is no central registry file to edit, no build step that collects keys across packages. A third-party plugin distributed as its own file is, from the host's point of view, indistinguishable from one of the nine the preset composes — which is the point of the whole design, not an accident of it.",
      ],
    },
  ],
};

export default doc;
