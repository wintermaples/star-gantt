/**
 * `@stargantt/sdk` — the shared micro-helpers the official StarGantt plugins are built from.
 *
 * This package is an ordinary library dependency: it has no plugin id, no `setup()` and no
 * registration surface. A third-party plugin can use exactly the helpers the official ones use.
 *
 * The public surface is organized into eight modules — time, cpm, dialog, dom, color, frame and
 * aggregate here, plus the plugin test harness (sdk/testing) — and re-exported flat from this
 * entry point. The per-module entry points exist for tree-shaking and documentation structure
 * only; every symbol is reachable from here.
 */
export * from "./time/index";
export * from "./cpm/index";
export * from "./dialog/index";
export * from "./dom/index";
export * from "./color/index";
export * from "./frame/index";
export * from "./aggregate/index";
export * from "./testing/index";
