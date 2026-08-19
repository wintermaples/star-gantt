/**
 * `downloadFile` (docs/specs/sdk.md, Module: sdk/dom): the one save incantation every export
 * plugin's `download*` member runs — object URL, detached `<a download>`, revoke.
 */
import { describe, expect, it } from "vitest";
import { downloadFile } from "../src/index";

interface Anchor {
  href: string;
  download: string;
  clicks: number;
  /** The object URL that was live at click time, so a revoke-too-early bug is visible. */
  hrefAtClick: string | null;
  parentNode: unknown;
}

interface Harness {
  doc: Document;
  anchors: Anchor[];
  created: { parts: unknown[]; type: string | undefined }[];
  minted: string[];
  revoked: string[];
}

/** A document double with a window carrying `URL` and `Blob`; `urls: false` removes the URL API. */
function harness(options: { urls?: boolean } = {}): Harness {
  const anchors: Anchor[] = [];
  const created: { parts: unknown[]; type: string | undefined }[] = [];
  const minted: string[] = [];
  const revoked: string[] = [];
  let live: string | null = null;

  /** Carries a blob's two observable members, so a built blob is recognized as one. */
  class FakeBlob {
    readonly size = 0;
    readonly type: string;
    constructor(
      readonly parts: unknown[],
      readonly options?: { type?: string },
    ) {
      this.type = options?.type ?? "";
      created.push({ parts, type: options?.type });
    }
  }

  const url =
    options.urls === false
      ? {}
      : {
          createObjectURL(): string {
            const href = `blob:fake/${String(minted.length)}`;
            minted.push(href);
            live = href;
            return href;
          },
          revokeObjectURL(href: string): void {
            revoked.push(href);
            live = null;
          },
        };

  const doc = {
    defaultView: { URL: url, Blob: FakeBlob },
    createElement(tag: string): Anchor {
      expect(tag).toBe("a");
      const anchor: Anchor = {
        href: "",
        download: "",
        clicks: 0,
        hrefAtClick: null,
        parentNode: null,
        click(): void {
          anchor.clicks += 1;
          anchor.hrefAtClick = live;
        },
      } as unknown as Anchor;
      anchors.push(anchor);
      return anchor;
    },
  } as unknown as Document;

  return { doc, anchors, created, minted, revoked };
}

describe("downloadFile", () => {
  it("wraps text in a blob of the given type and clicks a named anchor", () => {
    const h = harness();
    downloadFile(h.doc, "id,name\n1,Kick-off\n", "tasks.csv", "text/csv");

    expect(h.created).toEqual([{ parts: ["id,name\n1,Kick-off\n"], type: "text/csv" }]);
    expect(h.anchors).toHaveLength(1);
    expect(h.anchors[0]?.download).toBe("tasks.csv");
    expect(h.anchors[0]?.href).toBe(h.minted[0]);
    expect(h.anchors[0]?.clicks).toBe(1);
  });

  it("defaults the media type to application/octet-stream", () => {
    const h = harness();
    downloadFile(h.doc, new ArrayBuffer(4), "tasks.xlsx");
    expect(h.created[0]?.type).toBe("application/octet-stream");
  });

  it("passes a blob through instead of re-wrapping it, keeping its own media type", () => {
    const h = harness();
    const view = (h.doc as unknown as { defaultView: { Blob: new () => unknown } }).defaultView;
    const blob = new (view.Blob as unknown as new (p: unknown[], o?: { type?: string }) => Blob)(
      [],
      { type: "image/png" },
    );
    h.created.length = 0;
    downloadFile(h.doc, blob, "gantt.png");
    expect(h.created).toEqual([]);
    expect(h.minted).toHaveLength(1);
  });

  it("revokes the object URL after the click, never before it", () => {
    const h = harness();
    downloadFile(h.doc, "x", "a.txt");
    expect(h.anchors[0]?.hrefAtClick).toBe(h.minted[0]);
    expect(h.revoked).toEqual(h.minted);
  });

  it("leaves the anchor out of the document", () => {
    const h = harness();
    downloadFile(h.doc, "x", "a.txt");
    expect(h.anchors[0]?.parentNode).toBeNull();
  });

  it("is a silent no-op where object URLs are unavailable", () => {
    const h = harness({ urls: false });
    expect(() => downloadFile(h.doc, "x", "a.txt")).not.toThrow();
    expect(h.anchors).toEqual([]);
    expect(h.created).toEqual([]);
  });
});
