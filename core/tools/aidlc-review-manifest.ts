// The forms a review receipt's fingerprint takes. reviewArtifactContentsFingerprint
// in aidlc-lib.ts builds the manifest and remembers the older forms for
// currentFingerprintForm; this module never imports aidlc-lib.ts.
import { createHash } from "node:crypto";

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
