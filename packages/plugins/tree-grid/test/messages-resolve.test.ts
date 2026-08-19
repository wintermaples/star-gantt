/**
 * The plugin-wide catalog resolution: per-key shallow override across all 40 keys, including the
 * one builder key and the divider label's blank fallback.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MESSAGES, resolveMessages } from "../src/internal/messages";

describe("resolveMessages", () => {
  it("carries all forty keys, unchanged, with no overrides", () => {
    const resolved = resolveMessages(undefined);
    expect(Object.keys(resolved)).toHaveLength(40);
    expect(resolved).toEqual(DEFAULT_MESSAGES);
  });

  it("overrides per key and leaves the rest alone", () => {
    const resolved = resolveMessages({ nameColumn: "Nom", statusColumn: "État" });
    expect(resolved.nameColumn).toBe("Nom");
    expect(resolved.statusColumn).toBe("État");
    expect(resolved.startColumn).toBe(DEFAULT_MESSAGES.startColumn);
    expect(resolved.legendOverdue).toBe(DEFAULT_MESSAGES.legendOverdue);
  });

  it("takes the empty string verbatim", () => {
    expect(resolveMessages({ progressColumn: "" }).progressColumn).toBe("");
  });

  it("ignores a member that is not a string", () => {
    const resolved = resolveMessages({
      nameColumn: 7 as unknown as string,
      endColumn: undefined as unknown as string,
    });
    expect(resolved.nameColumn).toBe(DEFAULT_MESSAGES.nameColumn);
    expect(resolved.endColumn).toBe(DEFAULT_MESSAGES.endColumn);
  });

  it("ignores a non-object overrides argument", () => {
    expect(resolveMessages(null as unknown as undefined)).toEqual(DEFAULT_MESSAGES);
    expect(resolveMessages("nope" as unknown as undefined)).toEqual(DEFAULT_MESSAGES);
  });

  it("keeps a blank divider label at its default, since a focusable divider must carry a name", () => {
    expect(resolveMessages({ paneResizeLabel: "   " }).paneResizeLabel).toBe("Resize pane");
    expect(resolveMessages({ paneResizeLabel: "" }).paneResizeLabel).toBe("Resize pane");
    expect(resolveMessages({ paneResizeLabel: "Largeur" }).paneResizeLabel).toBe("Largeur");
  });

  it("takes a replacement builder for the one builder key, and ignores a non-function", () => {
    const built = resolveMessages({
      legendPriority: ({ priority }) => `P${priority}`,
    }).legendPriority({ priority: "high" });
    expect(built).toBe("Phigh");
    expect(
      resolveMessages({ legendPriority: "nope" as unknown as never }).legendPriority({
        priority: "high",
      }),
    ).toBe("Priority high");
  });

  it("defaults the two task-name keys to the same text under different keys", () => {
    expect(DEFAULT_MESSAGES.newTaskName).toBe("New task");
    expect(DEFAULT_MESSAGES.templateTaskName).toBe("New task");
    const resolved = resolveMessages({ newTaskName: "Tâche" });
    expect(resolved.newTaskName).toBe("Tâche");
    expect(resolved.templateTaskName).toBe("New task");
  });
});
