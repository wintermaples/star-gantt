// docs/specs/plugins/export.md §1.7 — the self-contained XML reader/writer.
import { describe, expect, it } from "vitest";
import { decodeEntities, escapeXml, parseXmlDocument } from "../src/internal/msproject/xml";
import { formatMspDate } from "../src/internal/msproject/serialize";

describe("escapeXml", () => {
  it("strips XML-1.0-illegal control characters instead of emitting them raw", () => {
    const withControls = "Task\x01\x0B\x1FName";
    const escaped = escapeXml(withControls);
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(escaped)).toBe(false);
    expect(escaped).toBe("TaskName");
  });

  it("still escapes the standard XML special characters", () => {
    expect(escapeXml(`<a> & "b" 'c'`)).toBe("&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;");
  });
});

describe("decodeEntities", () => {
  it("decodes standard named and numeric entities", () => {
    expect(decodeEntities("&lt;a&gt; &amp; &#65;")).toBe("<a> & A");
  });

  it("leaves a surrogate-range numeric reference undecoded", () => {
    expect(decodeEntities("x&#xD800;y")).toBe("x&#xD800;y");
    expect(decodeEntities("x&#55296;y")).toBe("x&#55296;y");
  });

  it("leaves an XML-illegal control code point undecoded", () => {
    expect(decodeEntities("x&#x0;y")).toBe("x&#x0;y");
    expect(decodeEntities("x&#xB;y")).toBe("x&#xB;y");
  });

  it("leaves the U+FFFE/U+FFFF non-characters undecoded", () => {
    expect(decodeEntities("x&#xFFFE;y")).toBe("x&#xFFFE;y");
    expect(decodeEntities("x&#xFFFF;y")).toBe("x&#xFFFF;y");
    expect(decodeEntities("x&#65534;y")).toBe("x&#65534;y");
    expect(decodeEntities("x&#65535;y")).toBe("x&#65535;y");
  });
});

describe("formatMspDate", () => {
  it("formats a normal epoch-ms instant", () => {
    expect(formatMspDate(0)).toBe("1970-01-01T00:00:00");
  });

  it("skips the date entirely for non-finite or out-of-range timestamps", () => {
    expect(formatMspDate(Number.NaN)).toBeUndefined();
    expect(formatMspDate(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(formatMspDate(8.64e15 + 1)).toBeUndefined(); // just past Date's representable range
  });
});

describe("parseXmlDocument DOCTYPE handling", () => {
  it("skips to the matching ]> when the DOCTYPE has an internal subset", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE Project [
  <!ENTITY evil "injected"> ]>
<Project><Tasks><Task><UID>1</UID><Name>N</Name></Task></Tasks></Project>`;
    const root = parseXmlDocument(xml);
    expect(root?.name).toBe("Project");
    expect(root?.children.find((c) => c.name === "Tasks")?.children).toHaveLength(1);
  });

  it("does not resolve a DOCTYPE-declared custom entity referenced in content", () => {
    const xml = `<!DOCTYPE Project [ <!ENTITY evil "injected"> ]>
<Project><Tasks><Task><UID>1</UID><Name>&evil;</Name></Task></Tasks></Project>`;
    const root = parseXmlDocument(xml);
    const name = root?.children
      .find((c) => c.name === "Tasks")
      ?.children[0]?.children.find((c) => c.name === "Name");
    // Undefined custom entities pass through undecoded rather than being resolved.
    expect(name?.text).toBe("&evil;");
  });

  it("still parses a DOCTYPE without an internal subset", () => {
    const xml = `<!DOCTYPE Project SYSTEM "project.dtd">
<Project><Tasks/></Project>`;
    const root = parseXmlDocument(xml);
    expect(root?.name).toBe("Project");
  });
});
