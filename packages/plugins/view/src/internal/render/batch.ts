// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * Layout read/write batching: queued callbacks drained once per paint pass, all reads before all
 * writes, so interleaved measure/mutate call sites cannot force one synchronous reflow each
 * (layout thrashing).
 */

export interface ReadWriteQueue {
  /** Queues a layout-reading callback for the next pass's read phase. Non-functions are ignored. */
  read(fn: () => void): void;
  /** Queues a layout-writing callback for the next pass's write phase. Non-functions are ignored. */
  write(fn: () => void): void;
  /**
   * Runs the currently queued reads, then the currently queued writes, each callback individually
   * guarded through `onFault`. Callbacks queued *during* the flush go to the next pass — the
   * scheduler is re-asked — so a write that queues a read cannot interleave phases within one pass.
   */
  flush(onFault: (error: unknown) => void): void;
  /** True while anything is queued. */
  pending(): boolean;
}

/** Creates the queue. `schedule` asks the frame loop for a pass when something is queued. */
export function createReadWriteQueue(schedule: () => void): ReadWriteQueue {
  let reads: (() => void)[] = [];
  let writes: (() => void)[] = [];

  function drain(list: (() => void)[], onFault: (error: unknown) => void): void {
    for (const fn of list) {
      try {
        fn();
      } catch (error) {
        onFault(error);
      }
    }
  }

  return {
    read(fn) {
      if (typeof fn !== "function") return;
      reads.push(fn);
      schedule();
    },
    write(fn) {
      if (typeof fn !== "function") return;
      writes.push(fn);
      schedule();
    },
    flush(onFault) {
      if (reads.length === 0 && writes.length === 0) return;
      const r = reads;
      const w = writes;
      reads = [];
      writes = [];
      drain(r, onFault);
      drain(w, onFault);
      // Anything queued by the drained callbacks waits for the next pass.
      if (reads.length > 0 || writes.length > 0) schedule();
    },
    pending: () => reads.length > 0 || writes.length > 0,
  };
}
