/** Hostless unit tests for the layout read/write queue (contract §6.8). */
import { describe, expect, it } from "vitest";
import { createReadWriteQueue } from "../../src/internal/render/batch";

describe("createReadWriteQueue", () => {
  it("runs every queued read before any queued write, regardless of queue order", () => {
    const order: string[] = [];
    const q = createReadWriteQueue(() => {});
    q.write(() => order.push("w1"));
    q.read(() => order.push("r1"));
    q.write(() => order.push("w2"));
    q.read(() => order.push("r2"));
    q.flush(() => {});
    expect(order).toEqual(["r1", "r2", "w1", "w2"]);
  });

  it("asks the scheduler for a pass when something is queued", () => {
    let scheduled = 0;
    const q = createReadWriteQueue(() => {
      scheduled += 1;
    });
    q.read(() => {});
    expect(scheduled).toBe(1);
    expect(q.pending()).toBe(true);
    q.flush(() => {});
    expect(q.pending()).toBe(false);
  });

  it("defers callbacks queued during a flush to the next pass and re-schedules", () => {
    const order: string[] = [];
    let scheduled = 0;
    const q = createReadWriteQueue(() => {
      scheduled += 1;
    });
    q.write(() => {
      order.push("w1");
      q.read(() => order.push("r-late"));
    });
    q.flush(() => {});
    expect(order).toEqual(["w1"]); // the late read did not interleave into this pass
    expect(scheduled).toBeGreaterThanOrEqual(2);
    q.flush(() => {});
    expect(order).toEqual(["w1", "r-late"]);
  });

  it("isolates a throwing callback and still runs the rest", () => {
    const order: string[] = [];
    const faults: unknown[] = [];
    const q = createReadWriteQueue(() => {});
    q.read(() => {
      throw new Error("read failed");
    });
    q.read(() => order.push("r2"));
    q.write(() => order.push("w1"));
    q.flush((e) => faults.push(e));
    expect(order).toEqual(["r2", "w1"]);
    expect((faults[0] as Error).message).toBe("read failed");
  });

  it("ignores non-function arguments", () => {
    const q = createReadWriteQueue(() => {});
    q.read(undefined as unknown as () => void);
    q.write(null as unknown as () => void);
    expect(q.pending()).toBe(false);
  });
});
