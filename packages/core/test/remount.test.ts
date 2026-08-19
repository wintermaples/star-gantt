/**
 * `dispose()` leaves the mount element clean for re-`create()`: no plugin-created DOM, listeners
 * or observers, and no classes, attributes or inline styles the plugins added to it; a fresh
 * `create()` on the same element behaves as a first mount. The kernel's part of that guarantee is
 * exercised here: every mount mutation a
 * plugin registers through `ctx.own()` is reverted on `dispose()`, and a second `create()` on
 * the very same element starts from a blank host (no leaked services/contributions/handlers).
 */
import { describe, expect, it } from "vitest";
import { Gantt } from "../src/index";
import { plug } from "./_keys";

/**
 * Minimal recording stand-in for a real mount element (core never touches the element itself —
 * so only the members the test plugin uses exist).
 */
class RecordingMount {
  children: unknown[] = [];
  className = "";
  attributes = new Map<string, string>();
  inlineStyle = new Map<string, string>();

  snapshot() {
    return {
      childCount: this.children.length,
      className: this.className,
      attributes: [...this.attributes.entries()].sort(),
      inlineStyle: [...this.inlineStyle.entries()].sort(),
    };
  }
}

/** A plugin that mutates the mount the way theme/viewer-embed do, with `ctx.own()` reverts. */
function mountMutatingPlugin(bootLog: string[]) {
  return plug("test.mount-mutator", (ctx) => {
    const mount = ctx.root as unknown as RecordingMount;
    bootLog.push("setup");

    const child = { tag: "div" };
    mount.children.push(child);
    ctx.own({
      dispose: () => void mount.children.splice(mount.children.indexOf(child), 1),
    });

    const prevClass = mount.className;
    mount.className = (prevClass ? prevClass + " " : "") + "sg-embed";
    ctx.own({ dispose: () => void (mount.className = prevClass) });

    mount.attributes.set("data-sg", "1");
    ctx.own({ dispose: () => void mount.attributes.delete("data-sg") });

    mount.inlineStyle.set("--sg-bar-fill", "#123456");
    ctx.own({ dispose: () => void mount.inlineStyle.delete("--sg-bar-fill") });
  });
}

describe("create → dispose → create on the same mount element", () => {
  it("dispose() restores the mount (children, class list, attributes, inline style)", () => {
    const mount = new RecordingMount();
    mount.className = "host-given";
    mount.attributes.set("id", "gantt-root");
    const before = mount.snapshot();

    const bootLog: string[] = [];
    const gantt = Gantt.create({
      element: mount as unknown as HTMLElement,
      plugins: [mountMutatingPlugin(bootLog)],
    });
    expect(mount.snapshot()).not.toEqual(before);

    gantt.dispose();
    expect(mount.snapshot()).toEqual(before);
  });

  it("a second create() on the same element behaves as a first mount", () => {
    const mount = new RecordingMount();
    const before = mount.snapshot();

    const bootLog: string[] = [];
    const first = Gantt.create({
      element: mount as unknown as HTMLElement,
      plugins: [mountMutatingPlugin(bootLog)],
    });
    first.dispose();

    const second = Gantt.create({
      element: mount as unknown as HTMLElement,
      plugins: [mountMutatingPlugin(bootLog)],
    });
    // The second boot ran its full setup exactly like the first (blank host, no leaks) …
    expect(bootLog).toEqual(["setup", "setup"]);
    // … produced the same single set of mount mutations rather than stacking onto residue …
    expect(mount.children.length).toBe(1);
    expect(mount.className).toBe("sg-embed");

    second.dispose();
    // … and its dispose() restores the pristine mount again.
    expect(mount.snapshot()).toEqual(before);
  });
});
