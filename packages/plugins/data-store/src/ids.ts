import type { Store } from "./store";
import type { LinkId, ResourceId, TaskId } from "./types";

/**
 * Deterministic id generation for tasks, links and transactions. The spec fixes none of these
 * shapes; a per-store counter is the minimum that satisfies "`Transaction.id: string`" and the
 * uniqueness the indexes require, without pulling in a dependency or touching `Date`.
 */
export class IdGen {
  private _task = 0;
  private _link = 0;
  private _resource = 0;
  private _tx = 0;

  nextTaskId(store: Store): TaskId {
    for (;;) {
      const id = `t${++this._task}`;
      if (!store.byId.has(id)) return id;
    }
  }

  nextLinkId(store: Store): LinkId {
    for (;;) {
      const id = `l${++this._link}`;
      if (!store.hasLink(id)) return id;
    }
  }

  nextResourceId(store: Store): ResourceId {
    for (;;) {
      const id = `r${++this._resource}`;
      if (!store.hasResource(id)) return id;
    }
  }

  nextTransactionId(): string {
    return `tx${++this._tx}`;
  }
}
