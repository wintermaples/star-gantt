/**
 * The per-chart colour-scheme pin and the scheme layer, end-to-end through the real core over
 * the shared test-utils fake DOM.
 *
 * What the pin has to do is narrow and all of it is observable on the element: put exactly one
 * `sg-scheme-*` class on the chart root, mirror it onto the inline `color-scheme`, take it off
 * again on `"auto"` and on disposal, and cost exactly one `tokens` store notification when it
 * changes — the class write is the one thing the plugin does that its own `MutationObserver`
 * would otherwise report back to it as a second refresh.
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyColorScheme, asColorScheme } from "../../src/internal/theme/scheme";
import { boot, probe } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

function start(...args: Parameters<typeof boot>): Booted {
  booted = boot(...args);
  return booted;
}

afterEach(() => {
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = null;
});

/**
 * Boots with a probe counting `tokens` store notifications — the replacement for the abolished
 * `theme/changed` event — and returns the count reader alongside the boot.
 */
function startCounting(config?: Parameters<typeof boot>[2]) {
  let changes = 0;
  const b = start(
    [probe((ctx) => void ctx.use("stargantt.theme").tokens.subscribe(() => void (changes += 1)))],
    {},
    config,
  );
  return { b, changes: () => changes };
}

describe("applyColorScheme (§4.2, pure)", () => {
  function target() {
    const classes = new Set<string>();
    return {
      classes,
      classList: {
        add: (name: string) => void classes.add(name),
        remove: (name: string) => void classes.delete(name),
      },
      style: {} as { colorScheme?: string },
    };
  }

  it("puts exactly one scheme class on the element and mirrors it onto color-scheme", () => {
    const t = target();
    applyColorScheme(t, "dark");
    expect([...t.classes]).toEqual(["sg-scheme-dark"]);
    expect(t.style.colorScheme).toBe("dark");

    // Switching schemes must not leave the previous class behind: both would declare the token
    // block on the element and the cascade would decide by source order rather than by intent.
    applyColorScheme(t, "light");
    expect([...t.classes]).toEqual(["sg-scheme-light"]);
    expect(t.style.colorScheme).toBe("light");
  });

  it("leaves no trace on \"auto\"", () => {
    const t = target();
    applyColorScheme(t, "dark");
    applyColorScheme(t, "auto");
    expect([...t.classes]).toEqual([]);
    expect(t.style.colorScheme).toBe("");
  });

  it("rejects anything that is not a scheme", () => {
    expect(asColorScheme("dark")).toBe("dark");
    expect(asColorScheme("AUTO")).toBeNull();
    expect(asColorScheme(1)).toBeNull();
    expect(asColorScheme(undefined)).toBeNull();
  });
});

describe("ThemeConfig.colorScheme and setColorScheme", () => {
  it("pins nothing by default", () => {
    const b = start();
    expect(b.gantt.service("stargantt.theme").colorScheme()).toBe("auto");
    expect(b.dom.root.className).toBe("");
  });

  it("applies the configured pin at setup", () => {
    const b = start([], {}, { colorScheme: "dark" });
    expect(b.dom.root.classList.contains("sg-scheme-dark")).toBe(true);
    expect(b.dom.root.style["colorScheme"]).toBe("dark");
    expect(b.gantt.service("stargantt.theme").colorScheme()).toBe("dark");
  });

  it("ignores an unusable configured pin", () => {
    const b = start([], {}, { colorScheme: "sepia" as never });
    expect(b.dom.root.className).toBe("");
    expect(b.gantt.service("stargantt.theme").colorScheme()).toBe("auto");
  });

  it("switches at runtime, notifying the tokens store once per real change", () => {
    const { b, changes } = startCounting();
    const svc = b.gantt.service("stargantt.theme");

    svc.setColorScheme("dark");
    expect(b.dom.root.classList.contains("sg-scheme-dark")).toBe(true);
    expect(changes()).toBe(1);

    // Re-applying the pin already in force is a no-op: no class churn, no store notification, no repaint.
    svc.setColorScheme("dark");
    expect(changes()).toBe(1);

    svc.setColorScheme("auto");
    expect(b.dom.root.className).toBe("");
    expect(changes()).toBe(2);
  });

  it("removes the pin on disposal — the root element is the host's and outlives the chart", () => {
    const b = start([], {}, { colorScheme: "light" });
    expect(b.dom.root.classList.contains("sg-scheme-light")).toBe(true);
    b.gantt.dispose();
    expect(b.dom.root.className).toBe("");
    expect(b.dom.root.style["colorScheme"]).toBe("");
    booted = { ...b, gantt: { dispose: () => {} } as unknown as Booted["gantt"] };
  });
});

describe("preset scheme pins", () => {
  const dark = { colorScheme: "dark" as const, tokens: { "--sg-bg": "#000000" } };

  it("pins the preset's scheme while it is applied and reverts when it is cleared", () => {
    const { b, changes } = startCounting({ presets: { midnight: dark } });
    const svc = b.gantt.service("stargantt.theme");

    svc.setPreset("midnight");
    expect(b.dom.root.classList.contains("sg-scheme-dark")).toBe(true);
    expect(svc.colorScheme()).toBe("dark");
    // The class write must not echo through the plugin's own MutationObserver as a second event.
    expect(changes()).toBe(1);

    svc.setPreset(null);
    expect(b.dom.root.className).toBe("");
    expect(svc.colorScheme()).toBe("auto");
    expect(changes()).toBe(2);
  });

  // The palette is authored for one scheme, so letting the host's pin win painted its dark
  // tokens onto a light-scheme element.
  it("lets the preset's own pin outrank the host's while it is applied", () => {
    const b = start([], {}, { colorScheme: "light", presets: { midnight: dark } });
    const svc = b.gantt.service("stargantt.theme");
    expect(svc.colorScheme()).toBe("light");

    svc.setPreset("midnight");
    expect(svc.colorScheme()).toBe("dark");
    expect(b.dom.root.classList.contains("sg-scheme-dark")).toBe(true);
    expect(b.dom.root.classList.contains("sg-scheme-light")).toBe(false);

    // A pin set while the preset stands is remembered, not applied…
    svc.setColorScheme("auto");
    expect(svc.colorScheme()).toBe("dark");

    // …and clearing the preset hands the element back to whatever the host last stated.
    svc.setPreset(null);
    expect(svc.colorScheme()).toBe("auto");
  });

  it("leaves the host's pin in force under a preset that names no scheme", () => {
    // A palette with no `colorScheme` of its own does not displace the pin.
    const b = start([], {}, {
      colorScheme: "light",
      presets: { plain: { "--sg-bg": "#123456" } },
    });
    const svc = b.gantt.service("stargantt.theme");
    svc.setPreset("plain");
    expect(svc.colorScheme()).toBe("light");
    expect(b.dom.root.classList.contains("sg-scheme-light")).toBe(true);
  });

  it("returns to the host's pin when the preset is cleared", () => {
    const b = start([], {}, { colorScheme: "light", presets: { midnight: dark } });
    const svc = b.gantt.service("stargantt.theme");
    svc.setPreset("midnight");
    expect(svc.colorScheme()).toBe("dark");
    svc.setPreset(null);
    expect(svc.colorScheme()).toBe("light");
    expect(b.dom.root.classList.contains("sg-scheme-light")).toBe(true);
  });

  it("drops an unusable colorScheme but keeps the preset's tokens", () => {
    const b = start([], {}, {
      presets: { odd: { colorScheme: "sepia", tokens: { "--sg-bg": "#123456" } } as never },
    });
    const svc = b.gantt.service("stargantt.theme");
    svc.setPreset("odd");
    expect(svc.get("--sg-bg")).toBe("#123456");
    expect(svc.colorScheme()).toBe("auto");
  });
});

// The theme layer used to declare its own `meta.id` ("stargantt.theme") and its own hard
// dependency on the renderer plugin. It is now a module of the merged `stargantt.view` plugin
// (`createThemeModule`, called directly from `wiring.ts` with the render module already in hand),
// so there is no longer a separate plugin identity to assert on — see `test/theme/theme.test.ts`
// for the fuller explanation and `test/render/renderer.test.ts` for `stargantt.view`'s own id and
// dependsOn.
describe.skip("plugin identity — theme is no longer its own plugin, see comment above", () => {
  it.skip("still declares the same id and dependency", () => {});
});
