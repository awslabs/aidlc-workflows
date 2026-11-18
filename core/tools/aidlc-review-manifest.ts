// The forms a recorded fingerprint takes: a committed file's text, a recorded
// digest checked in either form, and a review receipt's manifest.
// reviewArtifactContentsFingerprint in aidlc-lib.ts builds the manifest and
// remembers the older forms for currentFingerprintForm. The plugin sync and the
// opencode adapter check a plugin file against its record with the same
// reading from here; the adapter runs inside opencode and imports only modules
// whose own imports are node built-ins, so this module imports no sibling.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type ManifestEntry = [string, string];

function manifestFingerprint(manifest: ManifestEntry[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
}

/**
 * The fingerprint of a review manifest, as a receipt records it, and the older
 * forms of the same documents: `raw`, over the raw bytes before line endings
 * were read as LF (null when it is the same), and `older`, with no entry for an
 * optional output that is missing, which is how a receipt recorded before the
 * stage declared that output holds it. An optional output that appears, changes
 * or goes away after the review changes every form. `outputs` lines up with both
 * manifests, entry for entry.
 */
export function reviewManifestForms(
  manifest: ManifestEntry[],
  rawManifest: ManifestEntry[],
  outputs: ReadonlyArray<{ required: boolean; state: string }>,
): { fingerprint: string; raw: string | null; older: string[] } {
  const declared = (list: ManifestEntry[]) =>
    list.filter((_, at) => outputs[at].required || outputs[at].state !== "missing");
  const fingerprint = manifestFingerprint(manifest);
  const raw = manifestFingerprint(rawManifest);
  const older = new Set([declared(manifest), declared(rawManifest)].map(manifestFingerprint));
  older.delete(fingerprint);
  older.delete(raw);
  return { fingerprint, raw: raw === fingerprint ? null : raw, older: [...older] };
}

// A committed text file's bytes as its identity: CRLF reads as LF, so a
// checkout that turns line endings (Git for Windows' default) is no change to
// the work. Only a file Git itself converts is read this way; one it takes as
// binary (a NUL, a lone CR, or more than one control byte in 128 printable
// ones, as Git's convert.c counts them) is taken as it is, and a file with LF
// line endings is the same either way.
export function committedTextBytes(bytes: Buffer): Buffer {
  if (!bytes.includes(13) || process.env.AIDLC_TEST_RAW_LINE_ENDINGS === "1") return bytes;
  const parts: Buffer[] = [];
  return committedTextParts([bytes], (part) => parts.push(part)) ? Buffer.concat(parts) : bytes;
}

// Hands `emit` the text of `chunks` with each CRLF read as LF, a chunk at a
// time, and says whether that reading applies: true only for text with a CRLF.
// The caller takes the raw bytes when it is false.
export function committedTextParts(chunks: Iterable<Buffer>, emit: (part: Buffer) => void): boolean {
  let crlf = false;
  let pendingCr = false;
  let printable = 0;
  let nonprintable = 0;
  let last = -1;
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    if (pendingCr) {
      if (chunk[0] !== 10) return false;
      pendingCr = false;
    }
    let start = 0;
    for (let at = 0; at < chunk.length; at++) {
      const byte = chunk[at];
      if (byte === 13) {
        if (at + 1 === chunk.length) pendingCr = true;
        else if (chunk[at + 1] !== 10) return false;
        crlf = true;
        emit(chunk.subarray(start, at));
        start = at + 1;
        at++;
      } else if (byte === 0) {
        return false;
      } else if (byte === 127 || (byte < 32 && byte !== 10 && byte !== 8 && byte !== 9 && byte !== 27 && byte !== 12)) {
        nonprintable++;
      } else if (byte !== 10) {
        printable++;
      }
    }
    emit(chunk.subarray(start));
    last = chunk[chunk.length - 1];
  }
  // A trailing DOS end-of-file mark is not counted against the text.
  if (last === 26) nonprintable--;
  return crlf && !pendingCr && (printable >> 7) >= nonprintable;
}

// Does a recorded digest still name this file? A record written before the
// committed-text rule holds the raw-bytes digest of a CRLF file (a plugin root
// that is itself a CRLF clone); identical bytes are no change either, so that
// record proves the file too. The next record is written over the committed
// text.
export function recordedDigestMatches(path: string, recorded: string): boolean {
  const bytes = readFileSync(path);
  const digest = (data: Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;
  return digest(committedTextBytes(bytes)) === recorded || digest(bytes) === recorded;
}
