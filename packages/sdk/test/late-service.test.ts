/**
 * `lateService` (docs/specs/sdk.md, Module: sdk/frame): the memoized lazy optional-service
 * accessor.
 */
import { describe, expect, it } from "vitest";
import { lateService } from "../src/index";
import type { LateServiceContext } from "../src/index";

// The SDK compiles against an empty `Services`; the test merges one key in, exactly as a
// consuming plugin package would.
declare module "@stargantt/core" {
  interface Services {
    "test.late": { ping(): number };
  }
}

function ctxWith(sequence: (undefined | { ping(): number })[]): {
  ctx: LateServiceContext;
  calls: () => number;
} {
  let calls = 0;
  return {
    ctx: {
      useOptional: () => {
        calls += 1;
        return sequence.shift() as never;
      },
    },
    calls: () => calls,
  };
}

describe("lateService", () => {
  it("retries while the service is absent, then caches the first resolution", () => {
    const svc = { ping: () => 42 };
    const { ctx, calls } = ctxWith([undefined, undefined, svc]);
    const late = lateService(ctx, "test.late");
    expect(late()).toBeUndefined();
    expect(late()).toBeUndefined();
    expect(late()?.ping()).toBe(42);
    expect(calls()).toBe(3);
  });

  it("never asks the registry again once resolved", () => {
    const svc = { ping: () => 1 };
    const { ctx, calls } = ctxWith([svc, { ping: () => 2 }]);
    const late = lateService(ctx, "test.late");
    expect(late()).toBe(svc);
    expect(late()).toBe(svc);
    expect(late()).toBe(svc);
    expect(calls()).toBe(1);
  });
});
