// docs/specs/plugins/export.md §1.8 — minimal ZIP container writer. Hostless and dependency-free:
// entries are packed with the stored method (no compression, exact CRC-32s, UTF-8 names).

let CRC_TABLE: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (CRC_TABLE !== undefined) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

/** CRC-32 (IEEE 802.3) of a byte sequence, as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (table[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// Classic ZIP32 (no ZIP64) ceilings this writer is subject to: 4 GiB per entry and 4 GiB total
// archive size (32-bit size/offset fields), and 65535 max entries (16-bit entry counts in the
// EOCD record). None of these are checked or enforced here; callers must stay well under them.

// DOS date/time fields have no "unset" sentinel that readers treat as valid, so local/central
// headers use a fixed, deterministic timestamp instead of an all-zero one: 1980-01-01 00:00:00,
// the DOS epoch (§1.8). DOS date encoding is ((year-1980)<<9)|(month<<5)|day, so 1980-01-01
// encodes to (0<<9)|(1<<5)|1 = 0x21; DOS time (hours<<11)|(minutes<<5)|(seconds/2) for midnight is 0.
const DOS_DATE_1980_01_01 = 0x21;
const DOS_TIME_MIDNIGHT = 0;
const DOS_DATETIME_1980_01_01 = (DOS_DATE_1980_01_01 << 16) | DOS_TIME_MIDNIGHT;

/** Packs entries into a ZIP archive using the stored method (method 0, UTF-8 names). */
export function writeZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length + entry.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint32(10, DOS_DATETIME_1980_01_01, true); // dos time+date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); // method
    cv.setUint32(12, DOS_DATETIME_1980_01_01, true); // dos time+date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true); // local header offset (30/32..41 stay zero)
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
