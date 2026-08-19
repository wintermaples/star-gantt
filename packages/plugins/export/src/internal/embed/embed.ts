// docs/specs/plugins/export.md §2.3 — embed-mode dressing. Hostless: the stylesheet text is a pure
// function, scoped entirely to `EMBED_CLASS` so a composition without `embed: true` is untouched.
import { READONLY_CLASS } from "./guard";

/** Class the root carries in embed mode (§2.3). */
export const EMBED_CLASS = "sg-viewer-embed";

export { READONLY_CLASS };

/**
 * The embed-mode stylesheet: the root fills its container and text selection is disabled — an
 * embedded viewer pans and reads, it does not select. Nothing outside the embed class is styled.
 */
export function embedStyleText(): string {
  return [
    `.${EMBED_CLASS}{width:100%;height:100%;}`,
    `.${EMBED_CLASS}, .${EMBED_CLASS} *{-webkit-user-select:none;user-select:none;}`,
  ].join("\n");
}
