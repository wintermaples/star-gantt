/**
 * docs/specs/architecture.md — chapter 7 mechanical consistency check: `dependsOn` must exactly
 * match the providers implied by `ctx.use()`. data-store is the bottom layer (`dependsOn: []`)
 * and calls `ctx.use()` for nothing — its own `stargantt.fields` service is wired directly against
 * the local `data: DataService` closure, not looked up through the service registry — so no
 * `serviceProviders` map is needed here.
 */
import { expectDepsConsistency } from "@stargantt/sdk";
import { describe, it } from "vitest";
import { dataStore } from "../src/index";

describe("expectDepsConsistency", () => {
  it("dataStore()'s dependsOn matches its (empty) ctx.use() footprint", () => {
    expectDepsConsistency(dataStore());
  });

  it("holds for a non-default config too (customFields configured)", () => {
    expectDepsConsistency(dataStore({ customFields: { fields: [{ key: "cost" }] } }));
  });
});
