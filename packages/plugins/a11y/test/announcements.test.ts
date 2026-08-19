// @vitest-environment happy-dom
// docs/specs/plugins/a11y.md § Announcements — the two announcements driven by a store rather than
// by a keystroke: the sort cycle and the keyboard-initiated edit commit.
import { afterEach, describe, expect, it } from "vitest";
import { boot, flatTasks } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

function open(options: Parameters<typeof boot>[0] = {}): Booted {
  const b = boot({ tasks: flatTasks(3), ...options });
  booted = b;
  b.flushFrames();
  return b;
}

// Each step of the header sort cycle arrives as the tree-grid `grid` service's `sort` store.
describe("sort announcements", () => {
  it("speaks each step of the header sort cycle", () => {
    const b = open();
    b.grid.setSort({ columnId: "name", header: "Name", direction: "ascending" });
    expect(b.live.textContent).toBe("Name, sorted ascending");
    b.grid.setSort({ columnId: "name", header: "Name", direction: "descending" });
    expect(b.live.textContent).toBe("Name, sorted descending");
    // Sorting off carries no header of its own, so the column the cycle just left names it.
    b.grid.setSort(null);
    expect(b.live.textContent).toBe("Name, sort off");
  });

  it("speaks through the `messages` catalog when the host replaces it", () => {
    const b = open({
      config: {
        messages: {
          sortChanged: ({ header, direction }) =>
            direction === null ? `${header} : tri désactivé` : `${header} : tri ${direction}`,
        },
      },
    });
    b.grid.setSort({ columnId: "name", header: "Nom", direction: "ascending" });
    expect(b.live.textContent).toBe("Nom : tri ascending");
  });

  it("says nothing about sorting before any sort happens", () => {
    expect(open().live.textContent).toBe("");
  });

  it("says nothing when the sort state is republished unchanged", () => {
    const b = open();
    b.grid.setSort({ columnId: "name", header: "Name", direction: "ascending" });
    b.live.textContent = "";
    b.grid.setSort({ columnId: "name", header: "Name", direction: "ascending" });
    expect(b.live.textContent).toBe("");
  });
});

// The commit is detected via the `data` service's `tasks` store, paired with the plugin's own
// edit-start bookkeeping so a pointer commit stays silent.
describe("the keyboard edit-commit announcement", () => {
  it("speaks after an Enter-opened edit commits", () => {
    const b = open();
    b.key("ArrowDown"); // focus t1
    b.key("Enter"); // arms the announcement
    expect(b.grid.editStarts).toEqual(["t1"]);
    b.data.patch("t1", { name: "renamed" });
    expect(b.live.textContent).toBe("renamed, updated");
  });

  it("stays silent for a commit nothing armed — the pointer path", () => {
    const b = open();
    b.data.patch("t1", { name: "renamed" });
    expect(b.live.textContent).toBe("");
  });

  it("is disarmed by a pointer gesture", () => {
    const b = open();
    b.key("ArrowDown");
    b.key("Enter");
    b.pointerDown(b.root); // whatever commits now is indistinguishable from a pointer edit
    b.data.patch("t1", { name: "renamed" });
    expect(b.live.textContent).toBe("");
  });

  it("is disarmed by any other executed binding — a cancelled edit", () => {
    const b = open();
    b.key("ArrowDown");
    b.key("Enter");
    b.key("ArrowDown"); // another binding claimed a stroke
    b.live.textContent = "";
    b.data.patch("t1", { name: "renamed" });
    expect(b.live.textContent).toBe("");
  });

  it("speaks through the `messages` catalog when the host replaces it", () => {
    const b = open({ config: { messages: { editCommitted: (name) => `ok:${name ?? "?"}` } } });
    b.key("ArrowDown");
    b.key("Enter");
    b.data.patch("t1", { name: "renamed" });
    expect(b.live.textContent).toBe("ok:renamed");
  });

  it("says nothing for a store republication that touched no task", () => {
    const b = open();
    b.key("ArrowDown");
    b.key("Enter");
    b.data.republish();
    expect(b.live.textContent).toBe("");
  });
});
