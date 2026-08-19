// @vitest-environment happy-dom
// docs/specs/plugins/export.md §1.6 — the import dialog, built on `sdk/dialog` and
// `importCsv(text, { dialog: true })` (the standalone `openImportDialog` folds into the import
// methods, §1's fold map).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boot } from "./_boot";
import type { Booted } from "./_boot";

const HERE = dirname(fileURLToPath(import.meta.url));

let booted: Booted | undefined;
afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

const CSV = "name,start,end\nBrand new,1970-01-01,1970-01-03\nBad,huh,1970-01-03\n";

function openDialog(b: Booted, text = CSV): HTMLElement {
  b.service.importCsv(text, { dialog: true });
  const dialog = b.chartPane.querySelector<HTMLElement>(".sg-ie-dialog");
  if (dialog === null) throw new Error("dialog missing");
  return dialog;
}

describe("import dialog", () => {
  it("adds no DOM until asked to open (dialog: true)", () => {
    booted = boot();
    expect(booted.chartPane.querySelector(".sg-ie-dialog")).toBeNull();
    booted.service.importJson("[]", { dryRun: true });
    expect(booted.chartPane.querySelector(".sg-ie-dialog")).toBeNull();
  });

  it("opens with mapping rows, an issue list and a pre-checked change preview", () => {
    booted = boot();
    const dialog = openDialog(booted);
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Import data");
    expect(dialog.querySelectorAll(".sg-ie-mapping-row")).toHaveLength(3);
    expect(dialog.querySelector(".sg-ie-issues-heading")?.textContent).toBe("1 issue");
    expect([...dialog.querySelectorAll(".sg-ie-issue")].map((i) => i.textContent)).toEqual([
      'Unreadable start date "huh" (row 2)',
    ]);
    const changes = dialog.querySelectorAll(".sg-ie-change");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.getAttribute("data-kind")).toBe("add");
    expect(dialog.querySelector(".sg-ie-apply")?.textContent).toBe("Import 1 change");
  });

  it("re-parses and re-diffs when a column mapping is changed", () => {
    booted = boot();
    const dialog = openDialog(booted, "name,start,end\nBrand new,1970-01-01,1970-01-03\n");
    const select = dialog.querySelector<HTMLSelectElement>(".sg-ie-mapping-select");
    if (select === null) throw new Error("mapping select missing");
    select.value = "";
    select.dispatchEvent(new Event("change"));
    // With the name column ignored, the row loses its required name and the diff empties.
    expect(dialog.querySelector(".sg-ie-no-changes")?.textContent).toBe("No changes to import");
    expect([...dialog.querySelectorAll(".sg-ie-issue")].map((i) => i.textContent)).toEqual([
      'Missing required field "name" (row 1)',
    ]);
  });

  it("applies only the checked changes and closes, emitting cause dialog", () => {
    booted = boot();
    const dialog = openDialog(booted);
    dialog.querySelector<HTMLButtonElement>(".sg-ie-apply")?.click();
    expect(booted.chartPane.querySelector(".sg-ie-dialog")).toBeNull();
    expect(booted.data.getTask("import-1")?.name).toBe("Brand new");
    expect(booted.applied).toEqual([{ result: { added: 1, updated: 0, removed: 0 }, cause: "dialog" }]);
  });

  it("unchecking every change disables apply and applies nothing", () => {
    booted = boot();
    const dialog = openDialog(booted);
    const box = dialog.querySelector<HTMLInputElement>(".sg-ie-change input");
    if (box === null) throw new Error("checkbox missing");
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(dialog.querySelector(".sg-ie-apply")?.getAttribute("disabled")).toBe("");
    dialog.querySelector<HTMLButtonElement>(".sg-ie-apply")?.click();
    expect(booted.applied).toEqual([]);
    expect(booted.data.getTask("import-1")).toBeUndefined();
  });

  it("cascade-unchecks a child add while its parent add is unchecked", () => {
    booted = boot();
    const csv =
      "id,parent,name,start,end\nP,,New parent,1970-01-01,1970-01-03\nC,P,New child,1970-01-01,1970-01-02\n";
    const dialog = openDialog(booted, csv);
    const lines = dialog.querySelectorAll<HTMLElement>(".sg-ie-change");
    expect(lines).toHaveLength(2); // parents-first: P then C
    const parentBox = lines[0]?.querySelector<HTMLInputElement>("input");
    const childBox = lines[1]?.querySelector<HTMLInputElement>("input");
    if (!parentBox || !childBox) throw new Error("checkbox missing");

    // Unchecking the parent add unchecks and disables the dependent child add: applying it
    // alone would dispatch task/add with a parentId that will not exist.
    parentBox.checked = false;
    parentBox.dispatchEvent(new Event("change"));
    expect(childBox.checked).toBe(false);
    expect(childBox.getAttribute("disabled")).toBe("");

    // Re-checking the parent re-enables the child line.
    parentBox.checked = true;
    parentBox.dispatchEvent(new Event("change"));
    expect(childBox.getAttribute("disabled")).toBeNull();

    // With the parent unchecked again, apply must not create the orphan child.
    parentBox.checked = false;
    parentBox.dispatchEvent(new Event("change"));
    dialog.querySelector<HTMLButtonElement>(".sg-ie-apply")?.click();
    expect(booted.data.getTask("C")).toBeUndefined();
    expect(booted.data.getTask("P")).toBeUndefined();
  });

  it("cancels on Escape and on the cancel button with nothing applied", () => {
    booted = boot();
    let dialog = openDialog(booted);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(booted.chartPane.querySelector(".sg-ie-dialog")).toBeNull();

    dialog = openDialog(booted);
    dialog.querySelector<HTMLButtonElement>(".sg-ie-cancel")?.click();
    expect(booted.chartPane.querySelector(".sg-ie-dialog")).toBeNull();
    expect(booted.applied).toEqual([]);
  });

  it("uses replaced messages and falls back per call when a builder throws", () => {
    booted = boot({
      config: {
        messages: {
          dialogTitle: "取り込み",
          issuesHeading: () => {
            throw new Error("boom");
          },
        },
      },
    });
    const dialog = openDialog(booted);
    expect(dialog.getAttribute("aria-label")).toBe("取り込み");
    // The throwing builder is contained: default text used, error reported under this plugin's id.
    expect(dialog.querySelector(".sg-ie-issues-heading")?.textContent).toBe("1 issue");
    expect(booted.errors.map((e) => e.pluginId)).toContain("stargantt.export");
  });

  it("declares itself a modal (aria-modal) and mounts focused", () => {
    booted = boot();
    const dialog = openDialog(booted);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("a fresh open replaces whichever dialog is current", () => {
    booted = boot();
    openDialog(booted);
    const second = openDialog(booted, "name,start,end\nOther,1970-01-01,1970-01-02\n");
    expect(booted.chartPane.querySelectorAll(".sg-ie-dialog")).toHaveLength(1);
    expect(second.textContent).toContain("Other");
  });

  it("removes the dialog on plugin disposal", () => {
    booted = boot();
    openDialog(booted);
    const root = booted.root;
    booted.dispose();
    booted = undefined;
    expect(root.querySelector(".sg-ie-dialog")).toBeNull();
  });

  // Review M1 — the sdk/dialog panel always renders on its own `--sg-dialog-bg` (light) fallback,
  // since no theme in this program defines `--sg-dialog-*`; a chart token like `--sg-muted-fg`
  // repoints to a *dark*-appropriate value under a dark chart scheme and would go low-contrast on
  // that always-light panel. Every color on panel content must therefore come from the
  // `--sg-dialog-*` family, never a bare chart `--sg-*` token (the print-preview precedent).
  // Review round 2 — the DOM route is impossible here: the pinned happy-dom (20.11.2) silently
  // drops any `var(...)` value at the `CSSStyleDeclaration` level (the same finding
  // `filter-wire.test.ts` records for `calc(var(--x, 0px) + 8px)` — confirmed directly:
  // `el.style.color = "var(--x, #000)"` leaves `el.style.color === ""`, so a DOM-read assertion
  // passes trivially whether the source uses `--sg-dialog-muted-fg` or the buggy `--sg-muted-fg` —
  // it never actually reads what the source wrote. The only way to pin the token family is to read
  // the module's own source text and sweep it with the same regex the fix targets.
  it("colors every panel text node from the --sg-dialog-* token family, never a chart --sg-* token (source sweep)", () => {
    const dialogSource = readFileSync(resolve(HERE, "../src/internal/formats/dialog.ts"), "utf8");
    // Positive control: fails loudly (rather than vacuously passing on an empty/misread file) if
    // the resolved path is ever wrong or the file becomes unreadable.
    expect(dialogSource).toContain("var(--sg-dialog-");
    const chartTokens = dialogSource.match(/var\(--sg-(?!dialog-)[a-z-]+/g) ?? [];
    expect(chartTokens).toEqual([]);
  });
});
