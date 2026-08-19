// The one file-save incantation behind every export plugin's `download*` member (docs/specs/sdk.md,
// Module: sdk/dom), so no consumer leaks an object URL in its own variant.

/** The two window members the save needs, looked up per call rather than captured. */
interface SaveGlobals {
  URL?: { createObjectURL?: (blob: unknown) => string; revokeObjectURL?: (url: string) => void };
  Blob?: new (parts: unknown[], options?: { type?: string }) => unknown;
}

/** Whether `value` carries a blob's own two observable members. */
function isBlobLike(value: unknown): value is Blob {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { size?: unknown; type?: unknown };
  return typeof candidate.size === "number" && typeof candidate.type === "string";
}

/**
 * Saves `data` to the user's downloads as `filename`.
 *
 * This is the browser's one way to turn bytes into a saved file: the data is wrapped in a `Blob`
 * (unless it already is one), published as an object URL, handed to a detached `<a download>` that
 * is clicked, and the URL is revoked again immediately afterwards, so nothing is leaked and no
 * element is left in the document.
 *
 * `mimeType` is used only when `data` is not already a `Blob`; it defaults to
 * `application/octet-stream`. Where object URLs are unavailable — a server-side render, a test
 * environment without them — the call does nothing rather than throwing.
 */
export function downloadFile(
  doc: Document,
  data: Blob | ArrayBuffer | string,
  filename: string,
  mimeType?: string,
): void {
  const view = (doc.defaultView ?? globalThis) as unknown as SaveGlobals;
  const url = view.URL;
  const blobCtor = view.Blob;
  // An environment that cannot mint object URLs is a silent no-op, not a throw.
  if (url === undefined || typeof url.createObjectURL !== "function") return;

  // Duck-typed rather than `instanceof`: a blob minted in another realm (an iframe's document, a
  // worker) is still a blob, and re-wrapping one would bury the media type it already carries. A
  // pass-through `Blob` needs no constructor at all, so only the non-blob branch — which must
  // mint one — requires `blobCtor` to exist.
  if (!isBlobLike(data) && blobCtor === undefined) return;
  const blob = isBlobLike(data)
    ? data
    : new (blobCtor as NonNullable<SaveGlobals["Blob"]>)([data], {
        type: mimeType ?? "application/octet-stream",
      });
  const href = url.createObjectURL(blob);
  try {
    const anchor = doc.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    // Detached on purpose: a click on an anchor triggers the download without the element ever
    // being in the document, so no host layout can be disturbed by the save.
    anchor.click();
  } finally {
    if (typeof url.revokeObjectURL === "function") url.revokeObjectURL(href);
  }
}
