/**
 * Zero-dependency Flate/zlib helpers used to embed lossless page images in the self-written PDF.
 * DEFLATE compression itself is not implemented — every stream uses "stored" (uncompressed)
 * blocks (RFC 1951 §3.2.4), which are always valid DEFLATE output at the cost of compression
 * ratio. The zlib framing (RFC 1950: 2-byte header + Adler-32 trailer) is exact.
 */
// docs/specs/plugins/export.md §1.3 (PDF output) — emitting compressed DEFLATE is a tracked
// deferral, not an accepted permanent cost.

const MAX_STORED_BLOCK = 65535;

/** Adler-32 checksum, as required by the zlib stream trailer (RFC 1950). */
export function adler32(bytes: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Wraps `bytes` into DEFLATE "stored" (BTYPE=00) blocks: no compression, always valid output. */
function deflateStored(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) {
    // A single empty final stored block: BFINAL=1, BTYPE=00, LEN=0, NLEN=0xFFFF.
    return new Uint8Array([1, 0, 0, 0xff, 0xff]);
  }
  const blocks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const len = Math.min(MAX_STORED_BLOCK, bytes.length - offset);
    const isFinal = offset + len >= bytes.length;
    const nlen = ~len & 0xffff;
    const header = new Uint8Array([
      isFinal ? 1 : 0,
      len & 0xff,
      (len >> 8) & 0xff,
      nlen & 0xff,
      (nlen >> 8) & 0xff,
    ]);
    blocks.push(header, bytes.subarray(offset, offset + len));
    offset += len;
  }
  return concat(blocks);
}

/** Wraps DEFLATE-stored data in a zlib stream (RFC 1950): 2-byte header + Adler-32 trailer. */
export function zlibStored(bytes: Uint8Array): Uint8Array {
  // CMF=0x78 (32K window, DEFLATE), FLG=0x01 (no preset dict, FCHECK makes CMF*256+FLG a multiple of 31).
  const header = new Uint8Array([0x78, 0x01]);
  const body = deflateStored(bytes);
  const a = adler32(bytes);
  const trailer = new Uint8Array([(a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff]);
  return concat([header, body, trailer]);
}

/**
 * Builds the zlib-compressed PNG scanline stream for raw interleaved pixel data: every row is
 * prefixed with PNG filter-type byte 0 ("None", RFC 2083 §6.2), then the whole buffer is
 * zlib-wrapped per `zlibStored`. This is byte-for-byte what a PNG's IDAT chunk carries for an
 * unfiltered image, and is reusable directly as a PDF image stream under `/Filter /FlateDecode`
 * with the PNG predictor (`/DecodeParms << /Predictor 15 ... >>`) — no PNG file container (no
 * signature, no IHDR/IEND chunks) is needed for that embedding, so this module builds only the
 * scanline stream rather than a standalone `.png` file.
 */
export function pngScanlineStream(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  const rowBytes = width * channels;
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const dst = y * (rowBytes + 1);
    raw[dst] = 0; // filter type: None
    raw.set(pixels.subarray(src, src + rowBytes), dst + 1);
  }
  return zlibStored(raw);
}
