// Bun fetch decodes Brotli responses before AI-DLC can verify release checksums.
// The upstream CVE-2026-111497 regression stream must stop at the invalid switch.
// Source: oven-sh/bun, test/js/node/test/parallel/test-zlib-invalid-input.js.

import { expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { brotliCompressSync, brotliDecompressSync, createBrotliDecompress } from "node:zlib";

const invalidBlockSwitch = Buffer.from("200010414141fcffff07002228f00b60f7f41f000000", "hex");
const expectedError = { code: "ERR__ERROR_FORMAT_BLOCK_SWITCH", errno: -17 };

test("Brotli rejects an invalid block switch before continuing decoding", () => {
  assert.throws(() => brotliDecompressSync(invalidBlockSwitch), expectedError);
});

test("streamed Brotli rejects the same invalid switch one byte at a time", async () => {
  const decoder = createBrotliDecompress();
  const failure = new Promise<Error>((resolve, reject) => {
    decoder.once("error", resolve);
    decoder.once("end", () => reject(new Error("invalid Brotli stream was accepted")));
  });
  decoder.resume();
  for (const byte of invalidBlockSwitch) decoder.write(Buffer.from([byte]));
  decoder.end();
  expect(await failure).toMatchObject(expectedError);
});

test("valid Brotli responses still decompress", () => {
  const body = Buffer.from('{"version":"2.11.2","assets":[]}');
  expect(brotliDecompressSync(brotliCompressSync(body))).toEqual(body);
});
