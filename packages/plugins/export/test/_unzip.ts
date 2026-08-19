/** Test-only stored-method ZIP reader and worksheet-XML grid extractor for export assertions. */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** Unpacks a stored-method ZIP (the only method the writer under test emits) to name → text. */
export function unzipStored(input: ArrayBuffer | Uint8Array): Map<string, string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, string>();

  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== SIG_CENTRAL) throw new Error("bad central directory");
    if (view.getUint16(at + 10, true) !== 0) throw new Error("expected stored method");
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error("bad local header");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + size)));

    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
}

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Extracts the inline-string grid the writer emits from a worksheet part's XML text. */
export function gridOf(sheetXml: string): string[][] {
  const rows: string[][] = [];
  for (const row of sheetXml.matchAll(/<row r="\d+">(.*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of (row[1] as string).matchAll(
      /<c r="([A-Z]+)\d+" t="inlineStr"><is><t xml:space="preserve">(.*?)<\/t><\/is><\/c>/g,
    )) {
      // A1-style letters → 0-based index, so interior gaps land in the right slot.
      let index = 0;
      for (const ch of cell[1] as string) index = index * 26 + (ch.charCodeAt(0) - 64);
      index -= 1;
      while (cells.length < index) cells.push("");
      cells.push(unescapeXml(cell[2] as string));
    }
    rows.push(cells);
  }
  return rows;
}

/** Unzips a workbook and returns the single worksheet's grid. */
export function sheetGrid(workbook: ArrayBuffer | Uint8Array): string[][] {
  const xml = unzipStored(workbook).get("xl/worksheets/sheet1.xml");
  if (xml === undefined) throw new Error("no worksheet part");
  return gridOf(xml);
}

/** Unzips a workbook and returns the worksheet name written in xl/workbook.xml. */
export function sheetNameOf(workbook: ArrayBuffer | Uint8Array): string {
  const xml = unzipStored(workbook).get("xl/workbook.xml") ?? "";
  const match = /<sheet name="(.*?)"/.exec(xml);
  return match === null ? "" : unescapeXml(match[1] as string);
}
