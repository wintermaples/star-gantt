// docs/specs/plugins/a11y.md § Announcements — the keyboard edit-commit announcement.
/**
 * The keyboard path of an inline edit speaks its commit; the pointer path stays silent (a pointer
 * user sees the result). The two are told apart by *arming*: the `Enter` binding arms the
 * announcement for the row it opens, and the next change to that task is the commit. Anything that
 * could make the next change something else disarms it — another binding running, or any pointer
 * gesture.
 *
 * The commit is detected via the `data` service's `tasks` store: a task whose entry is not the
 * identical object it was in the previous snapshot has changed (the store publishes fresh task
 * objects per transaction), which covers an update, a removal and a re-creation alike.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";

/** The `tasks` store's value — the shape the announcer diffs. */
export type TaskSnapshot = ReadonlyMap<TaskId, Readonly<Task>>;

export interface EditAnnouncerDeps {
  /** The task's name after the commit, or `undefined` when the store no longer knows it. */
  taskName(id: TaskId): string | undefined;
  /** Speaks through the polite live region. */
  announce(message: string): void;
  /** The `editCommitted` catalog member. */
  editCommitted(name: string | undefined): string;
}

export interface EditAnnouncer {
  /** Arms the announcement for the row an `Enter` press just opened for editing. */
  arm(id: TaskId): void;
  /**
   * Disarms it: a cancelled edit (Escape), another binding, or a pointer gesture must not leave the
   * announcement armed until an unrelated later change to the same task — an undo, a move chord —
   * announced itself as "updated".
   */
  disarm(): void;
  /** Announces the commit when the armed task changed between the two snapshots, and disarms. */
  onTasksChanged(next: TaskSnapshot, prev: TaskSnapshot): void;
}

export function createEditAnnouncer(deps: EditAnnouncerDeps): EditAnnouncer {
  let pending: TaskId | undefined;
  return {
    arm: (id) => {
      pending = id;
    },
    disarm: () => {
      pending = undefined;
    },
    onTasksChanged: (next, prev) => {
      if (pending === undefined) return;
      // Identity, not deep equality: the store replaces the task object it changed, and an
      // untouched task keeps the very object the previous snapshot held.
      if (next.get(pending) === prev.get(pending)) return;
      const name = deps.taskName(pending);
      pending = undefined;
      deps.announce(deps.editCommitted(name));
    },
  };
}
