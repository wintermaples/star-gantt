// docs/specs/plugins/export.md §1.7 — minimal self-contained XML reader/writer: no `DOMParser`,
// no runtime dependency. Enough for MSPDI: element tree, text content, entity decoding,
// comments/CDATA/PIs handled, attributes ignored (MSPDI is element-based), namespace prefixes
// stripped from tag names.

export interface XmlElement {
  /** Local tag name (namespace prefix stripped). */
  name: string;
  children: XmlElement[];
  /** Concatenated direct text content, entity-decoded, trimmed. */
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** Decodes `&lt;`-style named and `&#..;`/`&#x..;` numeric entities; unknown ones pass through. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff && !isXmlIllegalCodePoint(code)
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * Whether `code` cannot appear as an XML 1.0 character: surrogate halves, illegal controls, and
 * the Unicode non-characters `U+FFFE`/`U+FFFF` (also illegal in XML 1.0, and any per-plane
 * `U+xFFFE`/`U+xFFFF` pair).
 */
function isXmlIllegalCodePoint(code: number): boolean {
  if (code >= 0xd800 && code <= 0xdfff) return true;
  if (code === 0x00 || code === 0x0b || code === 0x0c) return true;
  if (code <= 0x08) return true;
  if (code >= 0x0e && code <= 0x1f) return true;
  if ((code & 0xfffe) === 0xfffe) return true;
  return false;
}

/** Escapes text for XML element content, stripping characters XML 1.0 cannot represent. */
export function escapeXml(text: string): string {
  return text
    // Control characters are not representable in XML 1.0; drop them rather than corrupt the doc.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/[<>&"']/g, (ch) => {
      switch (ch) {
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case "&":
          return "&amp;";
        case '"':
          return "&quot;";
        default:
          return "&apos;";
      }
    });
}

function localName(raw: string): string {
  const colon = raw.indexOf(":");
  return colon >= 0 ? raw.slice(colon + 1) : raw;
}

/** Reader state threaded through the markup readers below. */
interface XmlReader {
  readonly text: string;
  root: XmlElement | undefined;
  readonly stack: XmlElement[];
  /** One accumulator of direct text parts per open element, joined at that element's close. */
  readonly textParts: string[][];
}

/** Returned by a markup reader in place of the next index when the document is malformed. */
const MALFORMED = -1;

function appendText(reader: XmlReader, part: string): void {
  reader.textParts[reader.textParts.length - 1]?.push(part);
}

/** Index just past `closer`, searching from `from + offset`; `MALFORMED` when it never closes. */
function skipUntil(text: string, from: number, closer: string, offset: number): number {
  const end = text.indexOf(closer, from + offset);
  return end < 0 ? MALFORMED : end + closer.length;
}

function readCdata(reader: XmlReader, at: number): number {
  const end = reader.text.indexOf("]]>", at + 9);
  if (end < 0) return MALFORMED;
  if (reader.stack.length > 0) appendText(reader, reader.text.slice(at + 9, end));
  return end + 3;
}

function readCloseTag(reader: XmlReader, at: number): number {
  const end = reader.text.indexOf(">", at);
  if (end < 0) return MALFORMED;
  const name = localName(reader.text.slice(at + 2, end).trim());
  const open = reader.stack.pop();
  const parts = reader.textParts.pop();
  if (open === undefined || open.name !== name) return MALFORMED;
  open.text = decodeEntities((parts ?? []).join("")).trim();
  // Trailing content after the root is tolerated (whitespace-only in practice).
  if (reader.stack.length === 0) reader.root ??= open;
  return end + 1;
}

function readOpenTag(reader: XmlReader, at: number): number {
  const end = reader.text.indexOf(">", at);
  if (end < 0) return MALFORMED;
  let inner = reader.text.slice(at + 1, end);
  const selfClosing = inner.endsWith("/");
  if (selfClosing) inner = inner.slice(0, -1);
  const space = inner.search(/\s/);
  const name = localName((space < 0 ? inner : inner.slice(0, space)).trim());
  if (name === "") return MALFORMED;
  const element: XmlElement = { name, children: [], text: "" };
  reader.stack[reader.stack.length - 1]?.children.push(element);
  if (selfClosing) {
    if (reader.stack.length === 0) reader.root ??= element;
  } else {
    reader.stack.push(element);
    reader.textParts.push([]);
  }
  return end + 1;
}

/**
 * Skips a `<!DOCTYPE ...>` declaration. When it carries an internal subset (`[...]` before the
 * closing `>`), custom entity/element declarations inside the subset are never read or resolved
 * (only the byte range is skipped) — skips to the matching `]>` rather than the first `>`, which
 * would land inside the subset and truncate the doctype.
 */
function readDoctype(text: string, at: number): number {
  const firstGt = text.indexOf(">", at);
  const bracket = text.indexOf("[", at);
  if (bracket < 0 || (firstGt >= 0 && bracket > firstGt)) {
    return firstGt < 0 ? MALFORMED : firstGt + 1;
  }
  const closeBracket = text.indexOf("]", bracket);
  if (closeBracket < 0) return MALFORMED;
  const end = text.indexOf(">", closeBracket);
  return end < 0 ? MALFORMED : end + 1;
}

/** Dispatches on the markup kind starting at `at` (a `<`) and returns the index just past it. */
function readMarkup(reader: XmlReader, at: number): number {
  const { text } = reader;
  if (text.startsWith("<!--", at)) return skipUntil(text, at, "-->", 4);
  if (text.startsWith("<![CDATA[", at)) return readCdata(reader, at);
  if (text.startsWith("<!DOCTYPE", at)) return readDoctype(text, at);
  if (text.startsWith("<?", at) || text.startsWith("<!", at)) return skipUntil(text, at, ">", 0);
  if (text.startsWith("</", at)) return readCloseTag(reader, at);
  return readOpenTag(reader, at);
}

/**
 * Parses one XML document and returns its root element, or `undefined` when the text is not
 * well-formed enough to read (unclosed tags, mismatched close tags, no root).
 */
export function parseXmlDocument(text: string): XmlElement | undefined {
  const reader: XmlReader = { text, root: undefined, stack: [], textParts: [] };
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i && reader.stack.length > 0) appendText(reader, text.slice(i, lt));
    i = readMarkup(reader, lt);
    if (i === MALFORMED) return undefined;
  }
  return reader.stack.length > 0 ? undefined : reader.root;
}

/** All direct children named `name`. */
export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((c) => c.name === name);
}

/** The first direct child named `name`, or `undefined`. */
export function childNamed(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((c) => c.name === name);
}

/** The trimmed text of the first direct child named `name`, or `undefined` when absent/empty. */
export function childText(element: XmlElement, name: string): string | undefined {
  const child = childNamed(element, name);
  return child === undefined || child.text === "" ? undefined : child.text;
}
