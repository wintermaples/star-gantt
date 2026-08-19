/**
 * The one piece of markup hand-written prose is allowed: `code` spans.
 *
 * Documentation about an API cannot avoid naming it mid-sentence, and a bare `rowHeight` sitting in
 * a proportional font reads as an English word rather than as something to type. Backticks were
 * already being written all over the corpus on the assumption that something rendered them; nothing
 * did, so the marks themselves were on screen.
 *
 * Deliberately not a Markdown subset. Bold, links and lists would each need a decision about what
 * happens when prose gets one wrong, and prose is the one thing here no test can check for meaning
 * — so the grammar is a single rule with one failure mode: an unpaired backtick stays a backtick.
 */
export interface InlineSegment {
  readonly text: string;
  readonly code: boolean;
}

/** A backtick pair, on one line, with something between them. Anything else is literal text. */
const CODE_SPAN = /`([^`\n]+)`/g;

export function segmentsOf(text: string): readonly InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  CODE_SPAN.lastIndex = 0;
  for (let match = CODE_SPAN.exec(text); match !== null; match = CODE_SPAN.exec(text)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), code: false });
    segments.push({ text: match[1]!, code: true });
    last = CODE_SPAN.lastIndex;
  }
  if (last < text.length) segments.push({ text: text.slice(last), code: false });
  return segments;
}

/** The same text with the marks removed — for the search index, where a backtick is noise. */
export function withoutMarks(text: string): string {
  return segmentsOf(text)
    .map((segment) => segment.text)
    .join("");
}
