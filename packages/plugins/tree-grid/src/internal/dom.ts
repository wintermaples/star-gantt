/** The one DOM-construction helper the grid's header and body share. */

/** Creates an element of `tag` carrying exactly `className`. */
export function el(doc: Document, tag: string, className: string): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
}
