/**
 * Contract §1.7 (`provide` / `use` / `useOptional`), §1.8 (`gantt.service`)
 * and §1.9 (`ServiceRegistry`, consumer-id enforcement).
 */
import { describe, expect, it } from "vitest";
import { Gantt } from "../src/index";
import { PluginHostImpl } from "../src/internal/host";
import { ServiceRegistryImpl } from "../src/internal/services";
import type { PluginDeps } from "../src/internal/kernel";
import type { AlphaService } from "./_keys";
import { fakeRoot, plug } from "./_keys";

const alpha = (name = "alpha"): AlphaService => ({ name, ping: () => `pong:${name}` });

describe("provide / use across plugins (§1.7)", () => {
  it("hands the consumer the exact instance the provider published", () => {
    const impl = alpha();
    let got: AlphaService | undefined;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.provider", (ctx) => ctx.provide("test.alpha", impl)),
        plug("test.consumer", (ctx) => void (got = ctx.use("test.alpha")), {
          dependsOn: ["test.provider"],
        }),
      ],
    });
    expect(got).toBe(impl);
    expect(got?.ping()).toBe("pong:alpha");
    g.dispose();
  });

  it("throws when a plugin uses a service whose provider is not in its dependsOn", () => {
    let caught: unknown;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.provider", (ctx) => ctx.provide("test.alpha", alpha())),
        plug("test.sneaky", (ctx) => {
          try {
            ctx.use("test.alpha");
          } catch (e) {
            caught = e;
          }
        }),
      ],
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("test.sneaky");
    expect((caught as Error).message).toContain("test.alpha");
    expect((caught as Error).message).toMatch(/dependsOn/);
    g.dispose();
  });

  it("throws when the service was never provided at all", () => {
    let caught: unknown;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.consumer", (ctx) => {
          try {
            ctx.use("test.beta");
          } catch (e) {
            caught = e;
          }
        }),
      ],
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("test.beta");
    g.dispose();
  });

  it("declaring the provider in dependsOn is not enough if nothing was provided", () => {
    let caught: unknown;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.provider", () => {}),
        plug("test.consumer", (ctx) => {
          try {
            ctx.use("test.alpha");
          } catch (e) {
            caught = e;
          }
        }, { dependsOn: ["test.provider"] }),
      ],
    });
    expect(caught).toBeInstanceOf(Error);
    g.dispose();
  });
});

describe("useOptional (§1.7)", () => {
  it("returns undefined when the service is absent", () => {
    let got: unknown = "untouched";
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [plug("test.consumer", (ctx) => void (got = ctx.useOptional("test.beta")))],
    });
    expect(got).toBeUndefined();
    g.dispose();
  });

  it("returns the implementation for a provider listed in `optional` (soft dep)", () => {
    const impl = alpha("soft");
    let got: AlphaService | undefined;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.provider", (ctx) => ctx.provide("test.alpha", impl)),
        plug("test.consumer", (ctx) => void (got = ctx.useOptional("test.alpha")), {
          optional: ["test.provider"],
        }),
      ],
    });
    expect(got).toBe(impl);
    g.dispose();
  });

  it("returns the implementation for a provider listed in `dependsOn` (hard dep)", () => {
    const impl = alpha("hard");
    let got: AlphaService | undefined;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.provider", (ctx) => ctx.provide("test.alpha", impl)),
        plug("test.consumer", (ctx) => void (got = ctx.useOptional("test.alpha")), {
          dependsOn: ["test.provider"],
        }),
      ],
    });
    expect(got).toBe(impl);
    g.dispose();
  });

  it("never throws", () => {
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.provider", (ctx) => ctx.provide("test.alpha", alpha())),
          plug("test.consumer", (ctx) => {
            ctx.useOptional("test.alpha");
            ctx.useOptional("test.beta");
          }),
        ],
      }).dispose(),
    ).not.toThrow();
  });
});

describe("`use` only sees services published before the consumer starts", () => {
  it("resolves a dependency's service because dependsOn orders the provider first", () => {
    const seen: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        // registered second but started first thanks to the dependency edge
        plug("test.consumer", (ctx) => void seen.push(ctx.use("test.alpha").name), {
          dependsOn: ["test.provider"],
        }),
        plug("test.provider", (ctx) => ctx.provide("test.alpha", alpha("ordered"))),
      ],
    });
    expect(seen).toEqual(["ordered"]);
    g.dispose();
  });
});

describe("gantt.service — application-code lookup (§1.8)", () => {
  it("bypasses the dependsOn check (the app declares no dependencies)", () => {
    const impl = alpha("app");
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [plug("test.provider", (ctx) => ctx.provide("test.alpha", impl))],
    });
    expect(g.service("test.alpha")).toBe(impl);
    g.dispose();
  });

  it("throws for a service that was never provided (the return type is non-optional)", () => {
    const g = Gantt.create({ element: fakeRoot(), plugins: [] });
    expect(() => g.service("test.alpha")).toThrowError(/test\.alpha/);
    g.dispose();
  });
});

describe("gantt.getService — optional application-code lookup (§1.8)", () => {
  it("answers with the service when it is composed", () => {
    const impl = alpha("app");
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [plug("test.provider", (ctx) => ctx.provide("test.alpha", impl))],
    });
    expect(g.getService("test.alpha")).toBe(impl);
    g.dispose();
  });

  it("answers undefined instead of throwing when it is not", () => {
    const g = Gantt.create({ element: fakeRoot(), plugins: [] });
    expect(g.getService("test.alpha")).toBeUndefined();
    g.dispose();
  });

  it("bypasses the dependsOn check exactly as service() does", () => {
    // The allowlist polices plugin-to-plugin edges; application code declares no dependencies, so
    // a service provided by a plugin nothing depends on is still reachable.
    const impl = alpha("undeclared");
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.other", () => undefined),
        plug("test.provider", (ctx) => ctx.provide("test.alpha", impl)),
      ],
    });
    expect(g.getService("test.alpha")).toBe(impl);
    g.dispose();
  });
});

describe("ServiceRegistry unit-level (§1.9)", () => {
  const deps = (): Map<string, PluginDeps> =>
    new Map<string, PluginDeps>([
      ["consumer", { hard: new Set(["provider"]), soft: new Set(["softprovider"]) }],
      ["stranger", { hard: new Set(), soft: new Set() }],
    ]);

  it("enforces the hard-dependency rule for get() and reports both plugin ids", () => {
    const reg = new ServiceRegistryImpl(deps());
    reg.provide("provider", "test.alpha", alpha());
    expect(reg.get("consumer", "test.alpha").name).toBe("alpha");
    expect(() => reg.get("stranger", "test.alpha")).toThrowError(/stranger/);
    expect(() => reg.get("stranger", "test.alpha")).toThrowError(/provider/);
  });

  it("treats a `null` consumer as application code and skips the check", () => {
    const reg = new ServiceRegistryImpl(deps());
    const impl = alpha();
    reg.provide("provider", "test.alpha", impl);
    expect(reg.get(null, "test.alpha")).toBe(impl);
    expect(reg.getOptional(null, "test.alpha")).toBe(impl);
  });

  it("accepts a soft dependency for getOptional but not for get", () => {
    const reg = new ServiceRegistryImpl(deps());
    const impl = alpha("soft");
    reg.provide("softprovider", "test.alpha", impl);
    expect(reg.getOptional("consumer", "test.alpha")).toBe(impl);
    expect(() => reg.get("consumer", "test.alpha")).toThrow();
  });

  it("getOptional returns undefined for an unprovided key", () => {
    const reg = new ServiceRegistryImpl(deps());
    expect(reg.getOptional("consumer", "test.alpha")).toBeUndefined();
    expect(reg.getOptional(null, "test.alpha")).toBeUndefined();
  });
});

describe("host wiring of dependency declarations", () => {
  it("feeds `dependsOn` / `optional` from plugin metadata into the registry", () => {
    const host = new PluginHostImpl(fakeRoot());
    const impl = alpha("wired");
    host.register(plug("p", (ctx) => ctx.provide("test.alpha", impl)));
    host.register(plug("c", () => {}, { dependsOn: ["p"] }));
    host.start();
    expect(host.services.get("c", "test.alpha")).toBe(impl);
    host.dispose();
  });
});
