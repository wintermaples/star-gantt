/** Hostless minimal PDF 1.4 writer: one full-page lossless (Flate) image per page, zero dependencies. */
// docs/specs/plugins/export.md §1.3 (PDF output)
import { pngScanlineStream } from "./png";

const PT_PER_PX = 72 / 96;

export interface PdfPageImage {
  /** Page box in CSS px (converted to points in the PDF). */
  widthPx: number;
  heightPx: number;
  /** Raster pixel size of the embedded image. */
  imageWidth: number;
  imageHeight: number;
  /** Raw interleaved RGB pixel bytes, row-major top-to-bottom, 3 bytes per pixel, no alpha. */
  pixels: Uint8Array;
}

const encoder = new TextEncoder();

/** Serializes the pages into one self-contained PDF 1.4 byte stream. */
export function buildPdf(pages: readonly PdfPageImage[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let position = 0;

  const push = (chunk: Uint8Array | string): void => {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    position += bytes.length;
  };
  const object = (body: () => void): number => {
    const id = offsets.length + 1;
    offsets.push(position);
    push(`${id} 0 obj\n`);
    body();
    push("endobj\n");
    return id;
  };

  push("%PDF-1.4\n");
  // Standard 4-byte high-bit binary marker (conventionally %E2E3CFD3-ish bytes >= 0x80) telling
  // naive text-based tools this file contains binary data. Pushed as raw bytes rather than
  // characters so no text encoder can lossily reinterpret them.
  push(new Uint8Array([0x25, 0xff, 0xff, 0xff, 0xff, 0x0a]));

  // Object ids are laid out up front: 1 catalog, 2 pages tree, then 3 objects per page.
  const pagesId = 2;
  const pageIds = pages.map((_, i) => 3 + i * 3);

  object(() => push(`<< /Type /Catalog /Pages ${pagesId} 0 R >>\n`)); // 1
  object(() =>
    push(
      `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>\n`,
    ),
  ); // 2

  pages.forEach((page, i) => {
    const wPt = (page.widthPx * PT_PER_PX).toFixed(2);
    const hPt = (page.heightPx * PT_PER_PX).toFixed(2);
    const contentId = pageIds[i]! + 1;
    const imageId = pageIds[i]! + 2;
    object(() =>
      push(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${wPt} ${hPt}] ` +
          `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\n`,
      ),
    );
    const content = `q\n${wPt} 0 0 ${hPt} 0 0 cm\n/Im0 Do\nQ\n`;
    const contentBytes = encoder.encode(content);
    object(() => {
      // /Length must reflect the encoded byte length of the stream, not the JS string's
      // .length (which counts UTF-16 code units and undercounts multi-byte characters).
      push(`<< /Length ${contentBytes.length} >>\nstream\n`);
      push(contentBytes);
      push("endstream\n");
    });
    object(() => {
      const stream = pngScanlineStream(page.pixels, page.imageWidth, page.imageHeight, 3);
      push(
        `<< /Type /XObject /Subtype /Image /Width ${page.imageWidth} /Height ${page.imageHeight} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
          `/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${page.imageWidth} >> ` +
          `/Length ${stream.length} >>\nstream\n`,
      );
      push(stream);
      push("\nendstream\n");
    });
  });

  const xref = position;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
