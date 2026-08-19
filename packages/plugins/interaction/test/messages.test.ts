/**
 * The merged message catalog (docs/specs/plugins/interaction.md §8): the normative defaults, the
 * per-key shallow override, and the containment every host-supplied builder is called behind.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MESSAGES, resolveMessages } from "../src/messages";
import type { InteractionMessages } from "../src/messages";

/** A resolution with a recording fault channel. */
function resolve(overrides: Partial<InteractionMessages> | undefined): {
  messages: InteractionMessages;
  faults: { key: string; error: unknown }[];
} {
  const faults: { key: string; error: unknown }[] = [];
  const messages = resolveMessages(overrides, (key, error) => faults.push({ key, error }));
  return { messages, faults };
}

describe("the catalog", () => {
  it("carries the 58 merged keys", () => {
    expect(Object.keys(DEFAULT_MESSAGES)).toHaveLength(58);
  });

  it("prefixes the eight keys that collided between the dialog and the panel", () => {
    for (const key of [
      "NameLabel",
      "StartLabel",
      "EndLabel",
      "ProgressLabel",
      "EditRejected",
      "ErrorInvalidDate",
      "ErrorDateOrder",
      "ErrorProgressRange",
    ]) {
      expect(DEFAULT_MESSAGES).toHaveProperty(`dialog${key}`);
      expect(DEFAULT_MESSAGES).toHaveProperty(`panel${key}`);
    }
  });

  it("renders the built-in English defaults byte for byte", () => {
    expect(DEFAULT_MESSAGES.deleteConfirmTitle(1)).toBe("Delete 1 task?");
    expect(DEFAULT_MESSAGES.deleteConfirmTitle(3)).toBe("Delete 3 tasks?");
    expect(DEFAULT_MESSAGES.deleteConfirmButton).toBe("Delete");
    expect(DEFAULT_MESSAGES.deleteCancelButton).toBe("Cancel");
    // 2024-01-09 and 2024-01-16, UTC, around a spaced en dash.
    expect(
      DEFAULT_MESSAGES.edited({ name: "Design", start: 1_704_758_400_000, end: 1_705_363_200_000 }),
    ).toBe("Design, 2024-01-09 – 2024-01-16");
    expect(DEFAULT_MESSAGES.progressEdited({ name: "Design", progress: 0.4 })).toBe("Design, 40%");
    expect(DEFAULT_MESSAGES.dragTooltip({ start: 1_704_758_400_000, end: 1_705_363_200_000 })).toBe(
      "2024-01-09 – 2024-01-16",
    );
    expect(DEFAULT_MESSAGES.copied(1)).toBe("Copied 1 task");
    expect(DEFAULT_MESSAGES.copied(2)).toBe("Copied 2 tasks");
    expect(DEFAULT_MESSAGES.pasted(1)).toBe("Pasted 1 task");
    expect(DEFAULT_MESSAGES.duplicated(4)).toBe("Duplicated 4 tasks");
    expect(DEFAULT_MESSAGES.matchCount(7)).toBe("7 matches");
    expect(DEFAULT_MESSAGES.multiSelection(2)).toBe("2 tasks selected");
    expect(DEFAULT_MESSAGES.incomingLink({ name: "Design", type: "FS" })).toBe("← Design (FS)");
    expect(DEFAULT_MESSAGES.outgoingLink({ name: "Build", type: "SS" })).toBe("→ Build (SS)");
    expect(DEFAULT_MESSAGES.assignment({ name: "Ann", units: 0.5 })).toBe("Ann × 0.5");
    expect(DEFAULT_MESSAGES.dialogEditRejected({ label: "Start" })).toBe(
      "Start: invalid value, edit not applied",
    );
    expect(DEFAULT_MESSAGES.panelEditRejected({ label: "End" })).toBe(
      "End: invalid value, edit not applied",
    );
  });

  it("renders a non-formattable instant as the empty segment rather than throwing", () => {
    expect(DEFAULT_MESSAGES.dragTooltip({ start: Number.NaN, end: 0 })).toBe(" – 1970-01-01");
  });
});

describe("resolution", () => {
  it("keeps every default when nothing is supplied", () => {
    const { messages } = resolve(undefined);
    expect(messages.deleteConfirmButton).toBe("Delete");
    expect(messages.menuLabel).toBe("Context menu");
  });

  it("overrides one key at a time and leaves the rest alone", () => {
    const { messages } = resolve({ deleteConfirmButton: "Entfernen" });
    expect(messages.deleteConfirmButton).toBe("Entfernen");
    expect(messages.deleteCancelButton).toBe("Cancel");
  });

  it("takes the empty string verbatim", () => {
    const { messages } = resolve({ zoomIn: "" });
    expect(messages.zoomIn).toBe("");
  });

  it("ignores a member of the wrong kind", () => {
    const { messages } = resolve({
      deleteConfirmButton: 7 as never,
      deleteConfirmTitle: "Delete?" as never,
    });
    expect(messages.deleteConfirmButton).toBe("Delete");
    expect(messages.deleteConfirmTitle(2)).toBe("Delete 2 tasks?");
  });

  it("ignores an override object that is not an object", () => {
    expect(resolve(null as never).messages.zoomOut).toBe("Zoom out");
    expect(resolve("nope" as never).messages.zoomOut).toBe("Zoom out");
  });

  it("calls a usable builder with the raw parts", () => {
    const build = vi.fn(() => "custom");
    const { messages, faults } = resolve({ copied: build });
    expect(messages.copied(3)).toBe("custom");
    expect(build).toHaveBeenCalledWith(3);
    expect(faults).toEqual([]);
  });

  it("reports a throwing builder and answers that call with the built-in default", () => {
    const boom = new Error("boom");
    const { messages, faults } = resolve({
      copied: () => {
        throw boom;
      },
    });
    expect(messages.copied(2)).toBe("Copied 2 tasks");
    expect(faults).toEqual([{ key: "copied", error: boom }]);
  });

  it("guards every call rather than latching the builder off after one fault", () => {
    let calls = 0;
    const { messages, faults } = resolve({
      matchCount: (count) => {
        calls += 1;
        if (calls === 1) throw new Error("first");
        return `${count}!`;
      },
    });
    expect(messages.matchCount(1)).toBe("1 matches");
    expect(messages.matchCount(2)).toBe("2!");
    expect(faults).toHaveLength(1);
  });
});
