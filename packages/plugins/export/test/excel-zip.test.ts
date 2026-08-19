// docs/specs/plugins/export.md §1.8 — the ZIP container writer.
import { describe, expect, it } from "vitest";
import { crc32, writeZip } from "../src/internal/excel/zip";
import { unzipStored } from "./_unzip";

const encoder = new TextEncoder();

describe("zip writer", () => {
  it("round-trips stored entries with correct names and bytes", () => {
    const entries = [
      { name: "hello.txt", data: encoder.encode("hello, zip") },
      { name: "dir/uni-éあ.xml", data: encoder.encode("<a>あ</a>") },
      { name: "empty.bin", data: new Uint8Array(0) },
    ];
    const unpacked = unzipStored(writeZip(entries));
    expect([...unpacked.keys()]).toEqual(entries.map((e) => e.name));
    for (const entry of entries) {
      expect(unpacked.get(entry.name)).toBe(new TextDecoder().decode(entry.data));
    }
  });

  it("computes the standard CRC-32", () => {
    // Reference value for "123456789" (IEEE 802.3): 0xCBF43926.
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
  });

  it("is deterministic: identical entries produce byte-identical archives", () => {
    const entries = [{ name: "a.xml", data: encoder.encode("<a/>") }];
    expect(writeZip(entries)).toEqual(writeZip(entries));
  });
});
