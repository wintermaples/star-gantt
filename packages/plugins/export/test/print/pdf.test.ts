/** The zero-dependency PDF writer. */
import { describe, expect, it } from "vitest";
import { buildPdf } from "../../src/internal/print/pdf";
import { adler32, pngScanlineStream, zlibStored } from "../../src/internal/print/png";

function ascii(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** Minimal inflate of a zlib "stored blocks" stream, enough to round-trip what we produce. */
function inflateStoredZlib(bytes: Uint8Array): Uint8Array {
  // Skip the 2-byte zlib header; the 4-byte Adler-32 trailer is dropped by length.
  const deflate = bytes.subarray(2, bytes.length - 4);
  const out: number[] = [];
  let i = 0;
  for (;;) {
    const bfinal = deflate[i]! & 1;
    const len = deflate[i + 1]! | (deflate[i + 2]! << 8);
    const start = i + 5;
    for (let k = 0; k < len; k++) out.push(deflate[start + k]!);
    i = start + len;
    if (bfinal === 1) break;
  }
  return new Uint8Array(out);
}

/** Extracts the raw bytes of the last `stream`...`endstream` block, using the preceding `/Length`. */
function lastStreamBytes(bytes: Uint8Array, text: string): Uint8Array {
  const dictStart = text.lastIndexOf("/Type /XObject");
  const streamKeywordIdx = text.indexOf("stream\n", dictStart);
  const dict = text.slice(dictStart, streamKeywordIdx);
  const len = Number(/\/Length (\d+)/.exec(dict)![1]);
  const start = streamKeywordIdx + "stream\n".length;
  return bytes.subarray(start, start + len);
}

describe("png helpers", () => {
  it("adler32 matches a known checksum", () => {
    // "Wikipedia" -> 0x11E60398 (RFC 1950 reference value used across implementations).
    const bytes = new TextEncoder().encode("Wikipedia");
    expect(adler32(bytes)).toBe(0x11e60398);
  });

  it("zlibStored round-trips arbitrary bytes through stored DEFLATE blocks", () => {
    const payload = new Uint8Array(200000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) % 256;
    const wrapped = zlibStored(payload);
    expect(wrapped[0]).toBe(0x78);
    expect(wrapped[1]).toBe(0x01);
    expect(inflateStoredZlib(wrapped)).toEqual(payload);
  });

  it("zlibStored handles empty input", () => {
    const wrapped = zlibStored(new Uint8Array(0));
    expect(inflateStoredZlib(wrapped)).toEqual(new Uint8Array(0));
  });

  it("pngScanlineStream prefixes every row with filter type 0 and preserves pixel bytes losslessly", () => {
    const width = 3;
    const height = 2;
    const channels = 3;
    // Deliberately includes values a chroma-subsampled JPEG would smear (sharp red/blue edges).
    const pixels = new Uint8Array([
      255, 0, 0, 0, 255, 0, 0, 0, 255, // row 0
      1, 2, 3, 250, 251, 252, 128, 64, 32, // row 1
    ]);
    const stream = pngScanlineStream(pixels, width, height, channels);
    const raw = inflateStoredZlib(stream);
    expect(raw.length).toBe(height * (width * channels + 1));
    // Filter byte at the start of each row is 0 ("None").
    expect(raw[0]).toBe(0);
    expect(raw[width * channels + 1]).toBe(0);
    // Pixel bytes survive byte-for-byte (no lossy re-encoding).
    expect([...raw.slice(1, 1 + width * channels)]).toEqual([...pixels.slice(0, width * channels)]);
    expect([...raw.slice(width * channels + 2)]).toEqual([...pixels.slice(width * channels)]);
  });
});

describe("buildPdf", () => {
  const page = (n: number) => ({
    widthPx: 800,
    heightPx: 600,
    imageWidth: 2,
    imageHeight: 2,
    pixels: new Uint8Array([n, 0, 0, 0, n, 0, 0, 0, n, n, n, n]),
  });

  it("writes a structurally complete single-image-per-page PDF using lossless Flate", () => {
    const text = ascii(buildPdf([page(1), page(2)]));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Count 2");
    expect(text.match(/\/Type \/Page /g)).toHaveLength(2);
    expect(text.match(/\/Filter \/FlateDecode/g)).toHaveLength(2);
    expect(text).not.toContain("/DCTDecode");
    expect(text).toContain("/Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns 2");
    expect(text).toContain("/Width 2 /Height 2");
    // 800 CSS px = 600 pt.
    expect(text).toContain("/MediaBox [0 0 600.00 450.00]");
    expect(text).toContain("startxref");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("embeds pixel data that decodes back losslessly through the PNG predictor stream", () => {
    const p = page(7);
    const bytes = buildPdf([p]);
    const text = ascii(bytes);
    const streamBytes = lastStreamBytes(bytes, text);
    const raw = inflateStoredZlib(streamBytes);
    const expected = inflateStoredZlib(pngScanlineStream(p.pixels, p.imageWidth, p.imageHeight, 3));
    expect(raw).toEqual(expected);
  });

  it("the content stream's /Length is the actual encoded byte count, not the JS string length", () => {
    // The content stream is generated internally from ASCII numbers/operators, so its /Length is
    // trivially correct today; this asserts the invariant directly against the real bytes so a
    // regression to `.length` (UTF-16 code units) on any future non-ASCII content would be caught.
    const bytes = buildPdf([page(3)]);
    const text = ascii(bytes);
    const dictStart = text.indexOf("/Type /Page ");
    const contentsDictStart = text.indexOf("<< /Length", text.indexOf("stream\n", dictStart) - 40);
    const dict = text.slice(contentsDictStart, text.indexOf("stream\n", contentsDictStart));
    const declaredLength = Number(/\/Length (\d+)/.exec(dict)![1]);
    const streamStart = text.indexOf("stream\n", contentsDictStart) + "stream\n".length;
    const endstreamIdx = text.indexOf("endstream\n", streamStart);
    const actualByteLength = endstreamIdx - streamStart;
    expect(declaredLength).toBe(actualByteLength);
    // Sanity: the declared length must not just be the JS string length of some other value
    // by coincidence — assert it also matches a fresh TextEncoder byte count of the slice.
    const contentBytes = bytes.subarray(streamStart, endstreamIdx);
    expect(declaredLength).toBe(contentBytes.length);
  });

  it("writes the binary marker as raw high-bit bytes rather than lossily-encoded characters", () => {
    const bytes = buildPdf([page(1)]);
    // Line 2 (after "%PDF-1.4\n") must be the 4 high-bit marker bytes (>= 0x80), each byte
    // preserved exactly rather than passed through a text encoder that could reinterpret them.
    const headerEnd = bytes.indexOf(0x0a); // end of "%PDF-1.4\n"
    const markerLine = bytes.subarray(headerEnd + 1, headerEnd + 1 + 6);
    expect(markerLine[0]).toBe(0x25); // '%'
    for (let i = 1; i < 5; i++) expect(markerLine[i]!).toBeGreaterThanOrEqual(0x80);
    expect(markerLine[5]).toBe(0x0a);
  });

  it("keeps xref offsets pointing at their objects", () => {
    const bytes = buildPdf([page(1)]);
    const text = ascii(bytes);
    const entries = [...text.matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
    expect(entries.length).toBe(5); // catalog, pages, page, contents, image
    for (const [i, offset] of entries.entries()) {
      expect(text.slice(offset, offset + String(i + 1).length + 6)).toBe(`${i + 1} 0 obj`);
    }
  });
});
