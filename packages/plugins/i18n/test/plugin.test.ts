// @vitest-environment happy-dom
// Plugin behavior on the real core: service publication, chart-locale default, the `state` store.
// docs/specs/plugins/i18n.md §1.2, §1.3
import { Gantt } from "@stargantt/core";
import type { GanttInstance } from "@stargantt/core";
import { createTestHost, expectDepsConsistency } from "@stargantt/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../src/index";
import type { I18nConfig, I18nService, I18nState } from "../src/index";

let gantt: GanttInstance | null = null;
afterEach(() => {
  gantt?.dispose();
  gantt = null;
});

function boot(config?: I18nConfig, locale?: string): { gantt: GanttInstance; svc: I18nService } {
  gantt = Gantt.create({
    element: document.createElement("div"),
    ...(locale === undefined ? {} : { locale }),
    plugins: [i18n(config)],
  });
  return { gantt, svc: gantt.service("stargantt.i18n") };
}

describe("plugin identity", () => {
  it("is `stargantt.i18n` with no dependencies and no ctx.use() calls", () => {
    expectDepsConsistency(i18n());
    expect(i18n().meta.id).toBe("stargantt.i18n");
    expect(i18n().meta.dependsOn).toEqual([]);
  });
});

describe("stargantt.i18n plugin", () => {
  it("publishes the service and resolves with the factory config", () => {
    const { svc } = boot({ translations: { en: { "treeGrid.name": "Name" } } });
    expect(svc.t("treeGrid.name")).toBe("Name");
  });

  it("defaults the active locale to the chart locale", () => {
    const { svc } = boot(undefined, "ja-JP");
    expect(svc.state.get().locale).toBe("ja-JP");
    expect(svc.state.get().resolutionOrder).toEqual(["ja-jp", "ja", "en"]);
  });

  it("lets a usable config locale override the chart locale", () => {
    const { svc } = boot({ locale: "fr" }, "ja-JP");
    expect(svc.state.get().locale).toBe("fr");
  });

  it("publishes state for observable changes only", () => {
    const { svc } = boot({ translations: { en: { k: "v" } } });
    const seen: I18nState[] = [];
    svc.state.subscribe((next) => seen.push(next));

    svc.setLocale("ja");
    svc.setLocale(""); // unusable → no publish
    svc.setLocale("ja"); // unchanged → no publish
    svc.setFallbacks(["fr"]);
    svc.add("ja", { k: "や" });
    svc.add("", { k: "x" }); // unusable → no publish
    svc.remove("unknown"); // no-op → no publish
    svc.remove("ja");

    expect(seen.map((s) => s.locale)).toEqual(["ja", "ja", "ja", "ja"]);
  });

  it("snapshots the config at the factory: later mutation has no effect", () => {
    const translations = { en: { k: "before" } };
    const config = { translations };
    const { svc } = boot(config);
    translations.en.k = "after";
    (config as { translations?: unknown }).translations = { en: { k: "later" } };
    expect(svc.t("k")).toBe("before");
  });
});

describe("createTestHost", () => {
  it("boots the same service through the shared harness", () => {
    const th = createTestHost({ plugins: [i18n({ locale: "de" })] });
    const svc = th.host.service("stargantt.i18n");
    expect(svc.state.get().locale).toBe("de");
    th.dispose();
  });
});
