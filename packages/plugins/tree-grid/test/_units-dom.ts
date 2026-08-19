/**
 * The fake-DOM half of the hostless internal-module scaffolding.
 *
 * Kept apart from `_units.ts` so a test that needs only the pure helpers (`unitColumn`,
 * `unitModel`, `flatRows`) does not pull the DOM double in with them.
 */
import { FakeDocument } from "./_harness/index";
import type { FakeElement } from "./_harness/index";

/** Casts the fake document to the DOM type the internal modules' signatures expect. */
export function asDoc(document: FakeDocument): Document {
  return document as unknown as Document;
}

/** A fake document whose elements all report `width` × `height`. */
export function unitDoc(width = 400, height = 300): FakeDocument {
  const document = new FakeDocument();
  document.defaultRect = { left: 0, top: 0, width, height };
  return document;
}

/** Reads a style property off a fake element (its `style` is a plain record). */
export function styleOf(el: FakeElement, property: string): string | undefined {
  return el.style[property];
}
