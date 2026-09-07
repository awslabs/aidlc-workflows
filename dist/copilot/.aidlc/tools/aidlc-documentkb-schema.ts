// DocumentKB index + per-document metadata schema — the machine-checkable
// realisation of the storage model in docs/guide/08-knowledge.md. Sibling of
// aidlc-rule-schema.ts / aidlc-sensor-schema.ts / aidlc-stage-schema.ts.
//
// Hand-rolled, zero-dep, PURE: no I/O, no process exit. Every validator returns
// a discriminated result so each caller attaches its own exit code and message.
//
// The governing rule for everything below: `index.json` and `metadata.json` are
// COMMITTED files, which means they are UNTRUSTED INPUT. They arrive from a
// clone, a merge, a rebase, or a hand-edit, and a reader that trusts their shape
// is an arbitrary-file-read with extra steps. So:
//
//   - schema_version is top-level and pinned. An unsupported version FAILS
//     CLOSED rather than being silently rewritten by this release's writer,
//     because a forward-version file rewritten by an older writer loses the
//     fields the newer one added.
//   - `source` is discriminated on `kind`, never a bag of optional fields, so
//     "managed with an alias" and "linked with no alias" are both unspellable.
//   - `extraction` is a six-state union, not a status string plus optionals:
//     each state carries different fields and implies a DIFFERENT remedy, and
//     collapsing them into one "unsupported" sends the user down the wrong path.
//   - `path` is NEVER absolute in either source kind. An absolute path in
//     committed metadata leaks one developer's directory layout to every clone,
//     and is the traversal primitive besides.
//   - derivatives are REVISION-BOUND: each carries the sha256 it was produced
//     from, so an edited original cannot serve stale extracted text under a
//     fresh digest.
//   - duplicate ids are REJECTED on read. Lookups are by id, so a duplicate
//     silently makes every row after the first unreachable.
//
// Path containment itself is NOT done here (this module is pure): callers pair
// these validators with assertNoSymlinkInChainOrThrow + a post-realpathSync
// containment re-check from aidlc-lib.ts.

// The only schema version this release reads or writes. Bumping this is a
// breaking change to a committed file: add a migration, do not widen the check.
export const DOCUMENTKB_SCHEMA_VERSION = 1;

// The six extraction states (design §3.1c). Each implies a distinct remedy:
//   extracted             -> none
//   no_extractable_text   -> supply a text version (OCR is out of scope for v1)
//   extractor_unavailable -> install the extractor; sync retries
//   extraction_failed     -> fix or replace the document
//   unsupported_type      -> none; indexed and citable, not extracted
//   invalidated           -> sync (the derivative predates the current sha256)
export const EXTRACTION_STATES = Object.freeze([
  "extracted",
  "no_extractable_text",
  "extractor_unavailable",
  "extraction_failed",
  "unsupported_type",
  "invalidated",
] as const);

export type ExtractionState = (typeof EXTRACTION_STATES)[number];

export const SOURCE_KINDS = Object.freeze(["managed", "linked"] as const);
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface ExtractorIdentity {
  name: string;
  // OPTIONAL because `extractor_unavailable` records a name with NO version: the
  // program never ran, so there is no version to report and inventing one would
  // be a fabricated fact. STATE_REQUIREMENTS is what enforces which shape each
  // state must carry -- it demands a version for every state that actually
  // executed something, and REJECTS one here. So a required `version` in this
  // type would contradict the validator rather than reinforce it.
  version?: string;
}

// Extracted text is only interpretable if you know what produced it, and an
// extractor VERSION change is grounds for re-extraction — so the identity is
// part of the record, not a log line.
export interface ExtractionRecord {
  state: ExtractionState;
  extractor?: ExtractorIdentity;
  chars?: number;
  truncated?: boolean;
  reason?: string;
  detectedType?: string;
  // The sha256 this derivative was produced FROM. Compared against the row's
  // current sha256 on every read; a mismatch means `invalidated`.
  source_revision?: string;
}

export type DocumentSource =
  | { kind: "managed"; path: string }
  | { kind: "linked"; alias: string; path: string };

// A summary is a STATE, not a path. S1 writes {state:"absent"}; S3 adds
// {state:"generated", path, source_revision}. The original schema made
// summary.md mandatory while S1 shipped no summaries — a contradiction.
export type SummaryRecord =
  | { state: "absent" }
  | { state: "generated"; path: string; source_revision: string };

export interface DocumentRow {
  id: string;
  source: DocumentSource;
  sha256: string;
  bytes: number;
  indexed_at: string;
  extraction: ExtractionRecord;
  // OMITTED for a space-wide document. Present means intent-scoped. An EMPTY
  // ARRAY IS INVALID — it is ambiguous between "space-wide" and "scoped to
  // nothing", and the two have different retrieval behaviour.
  related_intent_ids?: string[];
  // OMITTED when the document has no tags. Present means LLM-authored tags
  // exist. An EMPTY ARRAY IS INVALID, the same reasoning as
  // `related_intent_ids` above: it is ambiguous between "not yet tagged" (the
  // S1/pre-S3 state, spelled by omitting the key) and "tagged with nothing",
  // and a reader cannot tell which without asking the writer.
  tags?: string[];
  content?: string;
  /** Digest of the exact bytes stored at `content`. Readers verify this before
   * serving text so a failed multi-file publication cannot expose an older
   * derivative under a newer source revision. */
  content_sha256?: string;
  summary: SummaryRecord;
  /** Digest of the exact bytes stored at `summary.path`, present iff
   * `summary.state === "generated"` -- the same corroboration pattern as
   * `content_sha256`, sibling to `summary` rather than a field inside
   * `SummaryRecord` (S3a's shipped-and-reviewed type), so this is additive,
   * not a rewrite of that contract. Readers verify this before serving a
   * summary so a failed publish cannot expose stale bytes under a fresh
   * `source_revision`. */
  summary_sha256?: string;
  // A tombstone: the original is gone. Metadata-only by design, because a rule
  // promoted in S3 cites this id and the citation must not dangle.
  removed_at?: string;
}

export interface DocumentIndex {
  schema_version: number;
  documents: DocumentRow[];
}

export interface DocumentMetadata extends DocumentRow {
  schema_version: number;
  // Written at S1's WRITE time, never deferred to a reader. Whoever consumes
  // content.md later inherits whatever S1 recorded; there is no second writer.
  content_trust: "untrusted";
  content_handling: "data-not-instructions";
}

export type SchemaResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

// A real, parseable ISO-8601 timestamp -- not merely "a non-empty string", which
// is what `removed_at`'s validator checked for until a hand-edited
// `"not-a-date"` was measured to pass it outright. The regex fixes the SHAPE
// (date, `T`, time, and a `Z`/offset -- `Date.parse` alone accepts far looser
// strings, e.g. bare "2026-08-07", than this schema's own writer ever emits),
// and `Date.parse` after it fixes the VALUE (a shape-valid but impossible
// calendar date, e.g. "2026-13-45T00:00:00Z", still fails to parse). Both
// checks are required: the regex alone would accept a shape it cannot parse,
// and `Date.parse` alone would accept a shape this schema does not emit.
const ISO_TIMESTAMP_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

export function isValidIsoTimestamp(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const match = ISO_TIMESTAMP_REGEX.exec(raw);
  if (match === null || Number.isNaN(Date.parse(raw))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59) return false;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= maxDay;
}

// Bounds for the LLM-authored `tags` field (S3a). S1's precedent everywhere it
// stores anything free-form (`EXTRACT_OUTPUT_CHAR_CAP`, `BOLT_SLUG_MAX_LENGTH`,
// `UNIT_NAME_MAX_LENGTH` in aidlc-lib.ts) is: cap it, don't trust the producer
// to self-limit. A tag is a short label, not prose, so the per-tag cap is the
// same order of magnitude as those slug/name caps; the count cap keeps a
// runaway generation from turning `tags` into an unbounded second body.
export const MAX_TAGS_PER_DOCUMENT = 32;
export const MAX_TAG_LENGTH = 64;

// A tag is a short label, not prose and not a record separator. Measured
// against the shipped S3a validator: `"\t"`, `"a\nb"`, and `"a\0b"` all
// satisfied "non-empty string" literally while carrying no usable label —
// the same defect class §8.13 names for `removed_at`. C0 controls (incl.
// NUL/tab/newline) and DEL are refused outright. Charcode scan, not a regex
// character class, because the lint config forbids a literal control
// character range inside a regex.
function hasTagControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const SHA256_REGEX = /^[0-9a-f]{64}$/;
// The shipped uuidv7() output shape. Deliberately not a general UUID matcher:
// persistence is always a canonical UUID, and accepting a slug here is what
// would let a renameable display name become an identity.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// EXPORTED so every caller that is about to persist a UUID into a committed
// file (a `related_intent_ids` entry, a document id) checks it against the
// exact regex the schema will enforce on the very next read -- rather than a
// caller-local ad hoc check that can drift from this one. The onboard finding
// this closes: `resolveIntentFlag`'s bare-flag path resolved an orphan intent
// record (a dir with no registry row) to `uuid: ""`, which is a STRING, not
// `undefined` -- so `intentUuid !== undefined` at the call site was true, and
// `""` got written into `related_intent_ids`. The schema refused it on write,
// but only AFTER onboard's earlier passes had already renamed a completed
// document tree into place (see aidlc-knowledge.ts's stagePublish/onboard).
export function isCanonicalUuid(raw: string): boolean {
  return UUID_REGEX.test(raw);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A relative, POSIX-slashed, non-escaping path. Rejects absolutes (both POSIX
// and Windows-drive), any `..` segment, and backslashes — a committed path must
// mean the same thing on every machine that clones it.
export function validDocumentPath(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw) || raw.startsWith("\\")) return false;
  if (raw.includes("\\")) return false;
  if (raw.split("/").some((seg) => seg === ".." || seg === "")) return false;
  if (raw.includes("\0")) return false;
  return true;
}

function validateSource(raw: unknown, where: string, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push(`${where}.source must be an object`);
    return;
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(kind)) {
    errors.push(
      `${where}.source.kind must be one of ${SOURCE_KINDS.join(", ")} (got ${JSON.stringify(kind)})`,
    );
    return;
  }
  if (!validDocumentPath(raw.path)) {
    errors.push(
      `${where}.source.path must be a relative POSIX path with no ".." segment ` +
        `(got ${JSON.stringify(raw.path)}) — an absolute path in committed metadata ` +
        `leaks one machine's layout to every clone`,
    );
  }
  if (kind === "linked") {
    if (typeof raw.alias !== "string" || raw.alias.length === 0) {
      errors.push(`${where}.source.alias is required for a linked source`);
    }
  } else if ("alias" in raw) {
    // Discriminated means discriminated: a managed row carrying an alias is
    // ambiguous about which resolution path applies.
    errors.push(`${where}.source.alias is not valid on a managed source`);
  }
}

// What each state MUST carry, transcribed from the extraction-state table in
// docs/guide/08-knowledge.md. The table is the spec; this is the enforcement, so
// the two are meant to be diffed against each other by eye.
//
// `extractor` has three levels rather than two, and the middle one is the
// non-obvious case: `extractor_unavailable` means no extractor was FOUND, so it
// records the attempted NAME and cannot possibly know a version. Requiring
// name+version there would refuse the very record the state exists to express.
type ExtractorRequirement = "name-and-version" | "name-only" | "absent-ok";

interface StateRequirements {
  extractor: ExtractorRequirement;
  sourceRevision: boolean;
  chars: boolean;
  truncated: boolean;
  reason: boolean;
  detectedType: boolean;
}

const STATE_REQUIREMENTS: Readonly<Record<ExtractionState, StateRequirements>> = Object.freeze({
  // Text recovered: everything a reader needs to interpret and re-verify it.
  extracted: {
    extractor: "name-and-version",
    sourceRevision: true,
    chars: true,
    truncated: true,
    reason: false,
    detectedType: false,
  },
  // The extractor RAN and found no text layer, so it has a version and the
  // result is bound to the revision it inspected.
  no_extractable_text: {
    extractor: "name-and-version",
    sourceRevision: true,
    chars: false,
    truncated: false,
    reason: false,
    detectedType: false,
  },
  // The extractor was NOT found. Name only — there is no version to report.
  // `detectedType` IS required here (unlike its sibling failure states): a
  // retry (`shouldRetryExtraction`) needs to know WHICH mime this row was
  // routed for, to re-probe for an extractor now that one might be
  // configured/installed. Finding 5(c): without it, `detectMimeFromRow`
  // guessed from the file EXTENSION alone (".pdf" or bust, else
  // "text/plain") -- so installing a DOCX extractor never made a `.docx` row
  // retryable, because its guessed mime was never "application/docx" to
  // begin with.
  extractor_unavailable: {
    extractor: "name-only",
    sourceRevision: false,
    chars: false,
    truncated: false,
    reason: false,
    detectedType: true,
  },
  // The extractor ran and failed. `reason` is what makes each bound trip
  // distinguishable rather than one undifferentiated failure.
  extraction_failed: {
    extractor: "name-and-version",
    sourceRevision: false,
    chars: false,
    truncated: false,
    reason: true,
    detectedType: true,
  },
  // No extractor is even configured for this MIME type. Nothing ran.
  unsupported_type: {
    extractor: "absent-ok",
    sourceRevision: false,
    chars: false,
    truncated: false,
    reason: false,
    detectedType: true,
  },
  // A derivative that predates the current digest. Carries the STALE revision,
  // which is exactly what makes the mismatch visible.
  invalidated: {
    extractor: "absent-ok",
    sourceRevision: true,
    chars: false,
    truncated: false,
    reason: false,
    detectedType: false,
  },
});

function validateExtraction(raw: unknown, where: string, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push(`${where}.extraction must be an object`);
    return;
  }
  const state = raw.state;
  if (typeof state !== "string" || !(EXTRACTION_STATES as readonly string[]).includes(state)) {
    errors.push(
      `${where}.extraction.state must be one of ${EXTRACTION_STATES.join(", ")} ` +
        `(got ${JSON.stringify(state)})`,
    );
    return;
  }
  const req = STATE_REQUIREMENTS[state as ExtractionState];

  // --- extractor identity, per state ---
  if (req.extractor === "absent-ok") {
    if (raw.extractor !== undefined) {
      if (!isObject(raw.extractor) || typeof raw.extractor.name !== "string") {
        errors.push(`${where}.extraction.extractor, when present, must carry a name string`);
      }
    }
  } else if (!isObject(raw.extractor) || typeof raw.extractor.name !== "string") {
    errors.push(
      `${where}.extraction.extractor.name is required when state is "${state}" — ` +
        `extracted text is only interpretable if you know what produced it`,
    );
  } else if (req.extractor === "name-and-version" && typeof raw.extractor.version !== "string") {
    errors.push(
      `${where}.extraction.extractor.version is required when state is "${state}" — ` +
        `the extractor ran, and a version change is grounds for re-extraction`,
    );
  } else if (req.extractor === "name-only" && raw.extractor.version !== undefined) {
    // Not pedantry: a version here would be a fabricated fact, since the state
    // means the extractor was never found, let alone run.
    errors.push(
      `${where}.extraction.extractor.version must be absent when state is "${state}" — ` +
        `no extractor was found, so there is no version to report`,
    );
  }

  // --- source_revision ---
  if (raw.source_revision !== undefined && !SHA256_REGEX.test(String(raw.source_revision))) {
    errors.push(`${where}.extraction.source_revision must be a lowercase sha256 hex digest`);
  }
  if (req.sourceRevision && raw.source_revision === undefined) {
    errors.push(
      `${where}.extraction.source_revision is required when state is "${state}" — ` +
        `without it there is no way to tell whether the derivative still matches the original`,
    );
  }

  // --- per-state companions ---
  if (req.chars && (typeof raw.chars !== "number" || !Number.isInteger(raw.chars) || raw.chars < 0)) {
    errors.push(`${where}.extraction.chars must be a non-negative integer when state is "${state}"`);
  }
  if (req.truncated && typeof raw.truncated !== "boolean") {
    errors.push(
      `${where}.extraction.truncated must be a boolean when state is "${state}" — ` +
        `a reader cannot tell a complete extraction from a capped one without it`,
    );
  }
  if (req.reason && typeof raw.reason !== "string") {
    errors.push(
      `${where}.extraction.reason is required when state is "${state}" — ` +
        `each distinct failure needs its own reason, or every bound trip looks alike`,
    );
  }
  if (req.detectedType && typeof raw.detectedType !== "string") {
    errors.push(`${where}.extraction.detectedType is required when state is "${state}"`);
  }
}

// `id` is threaded in so a derivative path can be bound to the ROW IT
// DESCRIBES, not merely shaped like a path. Without this, a hand-edited row A
// can carry `summary.path: "documentkb/<B>/summary.md"` and pass validation
// while serving B's derivative under A's citation -- the same class of defect
// `content` below closes.
function validateSummary(raw: unknown, id: unknown, where: string, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push(`${where}.summary must be an object (a state, not a path)`);
    return;
  }
  if (raw.state === "absent") return;
  if (raw.state === "generated") {
    if (!validDocumentPath(raw.path)) {
      errors.push(`${where}.summary.path must be a relative POSIX path`);
    } else if (typeof id === "string" && raw.path !== `documentkb/${id}/summary.md`) {
      errors.push(
        `${where}.summary.path must be documentkb/${id}/summary.md -- a summary is always the ` +
          `row's OWN derivative, never another row's`,
      );
    }
    if (!SHA256_REGEX.test(String(raw.source_revision))) {
      errors.push(`${where}.summary.source_revision must be a sha256 digest (revision-bound)`);
    }
    return;
  }
  errors.push(`${where}.summary.state must be "absent" or "generated"`);
}

function validateRow(raw: unknown, where: string, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (typeof raw.id !== "string" || !UUID_REGEX.test(raw.id)) {
    errors.push(`${where}.id must be a canonical UUID (got ${JSON.stringify(raw.id)})`);
  }
  if (typeof raw.sha256 !== "string" || !SHA256_REGEX.test(raw.sha256)) {
    errors.push(`${where}.sha256 must be a lowercase sha256 hex digest`);
  }
  if (typeof raw.bytes !== "number" || !Number.isInteger(raw.bytes) || raw.bytes < 0) {
    errors.push(`${where}.bytes must be a non-negative integer`);
  }
  if (!isValidIsoTimestamp(raw.indexed_at)) {
    errors.push(`${where}.indexed_at must be an ISO timestamp string`);
  }
  validateSource(raw.source, where, errors);
  validateExtraction(raw.extraction, where, errors);
  validateSummary(raw.summary, raw.id, where, errors);

  if ("related_intent_ids" in raw && raw.related_intent_ids !== undefined) {
    const ids = raw.related_intent_ids;
    if (!Array.isArray(ids)) {
      errors.push(`${where}.related_intent_ids must be an array when present`);
    } else if (ids.length === 0) {
      // Stated verbatim in the RFC. Ambiguous between "space-wide" (which is
      // spelled by OMITTING the key) and "scoped to nothing".
      errors.push(
        `${where}.related_intent_ids must be OMITTED for a space-wide document — ` +
          `an empty list is invalid, because it is ambiguous between "space-wide" ` +
          `and "scoped to nothing"`,
      );
    } else {
      for (const [i, id] of ids.entries()) {
        if (typeof id !== "string" || !UUID_REGEX.test(id)) {
          // A slug is only ever INPUT. Persistence is always a UUID, because a
          // slug is a display name and can be renamed or reused.
          errors.push(
            `${where}.related_intent_ids[${i}] must be a canonical UUID, not a slug ` +
              `(got ${JSON.stringify(id)})`,
          );
        }
      }
    }
  }
  if ("tags" in raw && raw.tags !== undefined) {
    const tags = raw.tags;
    if (!Array.isArray(tags)) {
      errors.push(`${where}.tags must be an array when present`);
    } else if (tags.length === 0) {
      // Same reasoning as related_intent_ids: OMIT the key for "no tags", do
      // not spell it with an empty array — an empty array is ambiguous
      // between "not yet tagged" and "deliberately tagged with nothing", and
      // the two would need different remedies if this ever surfaces in retrieval.
      errors.push(
        `${where}.tags must be OMITTED when a document has no tags — an empty ` +
          `list is invalid, because it is ambiguous between "not yet tagged" ` +
          `and "tagged with nothing"`,
      );
    } else if (tags.length > MAX_TAGS_PER_DOCUMENT) {
      errors.push(
        `${where}.tags has ${tags.length} entries, over the ${MAX_TAGS_PER_DOCUMENT}-tag cap`,
      );
    } else {
      // Trim contract: REJECT, never silently rewrite. This schema validates
      // rather than normalises (see schema_version's comment at the top of
      // this file) — a writer that stored `tag.trim()` on the caller's behalf
      // would rewrite data the caller believes it wrote verbatim. So leading/
      // trailing whitespace (and a whitespace-only tag, which trims to "") is
      // refused with a message the caller can act on, not fixed for them.
      const seen = new Map<string, number>(); // normalised key -> first index
      for (const [i, tag] of tags.entries()) {
        if (typeof tag !== "string" || tag.length === 0) {
          errors.push(`${where}.tags[${i}] must be a non-empty string (got ${JSON.stringify(tag)})`);
          continue;
        }
        if (hasTagControlChar(tag)) {
          errors.push(
            `${where}.tags[${i}] must not contain control characters (tab/newline/NUL/etc) — ` +
              `a tag is a short label, not prose (got ${JSON.stringify(tag)})`,
          );
          continue;
        }
        if (tag.trim() !== tag || tag.trim().length === 0) {
          errors.push(
            `${where}.tags[${i}] must not have leading/trailing whitespace and must not be ` +
              `whitespace-only (got ${JSON.stringify(tag)}) — trim it before writing, this ` +
              `schema does not trim on your behalf`,
          );
          continue;
        }
        if (tag.length > MAX_TAG_LENGTH) {
          errors.push(
            `${where}.tags[${i}] is ${tag.length} chars, over the ${MAX_TAG_LENGTH}-char cap`,
          );
          continue;
        }
        // Duplicate detection: NFC-normalise then case-fold, so "A"/"a" and an
        // NFC/NFD-lookalike `é` pair both collide even though `===` on the raw
        // strings would not catch either.
        const key = tag.normalize("NFC").toLowerCase();
        const firstIndex = seen.get(key);
        if (firstIndex !== undefined) {
          errors.push(
            `${where}.tags[${i}] duplicates tags[${firstIndex}] (${JSON.stringify(tag)} and ` +
              `${JSON.stringify(tags[firstIndex])} are the same tag once case-folded and ` +
              `Unicode-normalised)`,
          );
        } else {
          seen.set(key, i);
        }
      }
    }
  }
  if (raw.content !== undefined) {
    if (!validDocumentPath(raw.content)) {
      errors.push(`${where}.content must be a relative POSIX path`);
    } else if (typeof raw.id === "string" && raw.content !== `documentkb/${raw.id}/content.md`) {
      // CANONICAL BINDING, not more path hardening. `validDocumentPath` already
      // refuses `..`/absolute/backslash escapes (measured: a
      // `../../../../etc/hosts` variant is refused there, not here) -- the gap
      // this closes is different: a row can point `content` at ANOTHER row's
      // own well-formed, in-bounds path (`documentkb/<other-id>/content.md`),
      // which no escape check catches because the string never leaves
      // documentkb/. A row's content must be exactly its OWN derivative.
      errors.push(
        `${where}.content must be documentkb/${raw.id}/content.md -- content is always the ` +
          `row's OWN derivative, never another row's`,
      );
    }
    if (typeof raw.content_sha256 !== "string" || !SHA256_REGEX.test(raw.content_sha256)) {
      errors.push(`${where}.content_sha256 must be a lowercase sha256 digest when content is present`);
    }
  } else if (raw.content_sha256 !== undefined) {
    errors.push(`${where}.content_sha256 must be absent when content is absent`);
  }
  // A SIBLING of `summary` (S3a's shipped, reviewed, two-state union), not a
  // field inside it -- this is additive, not a rewrite of that contract. Kept
  // OPTIONAL even when summary.state is "generated": S3a's own pinned tests
  // (t325) construct a valid `generated` summary carrying only path +
  // source_revision, with no digest field at all, and that shape must keep
  // validating. So this is corroboration when a writer supplies it (every
  // write this release makes does), not a NEW requirement layered onto an
  // already-shipped state -- the same asymmetry `related_intent_ids` has
  // relative to `tags`: two similar-shaped fields, added at different times,
  // are not obligated to share a strictness level.
  const summaryState = isObject(raw.summary) ? raw.summary.state : undefined;
  if (raw.summary_sha256 !== undefined) {
    if (summaryState !== "generated") {
      errors.push(`${where}.summary_sha256 must be absent when summary.state is not "generated"`);
    } else if (typeof raw.summary_sha256 !== "string" || !SHA256_REGEX.test(raw.summary_sha256)) {
      errors.push(`${where}.summary_sha256, when present, must be a lowercase sha256 digest`);
    }
  }
  if ("removed_at" in raw && raw.removed_at !== undefined) {
    // A malformed tombstone must not read as LIVE. `isTombstoned()` treats
    // anything other than a non-empty string as active, so `{}` or `null`
    // here would pass validation while the reader shows the row as indexed.
    // The check itself must match what the message PROMISES: a bare
    // non-empty-string check let `"not-a-date"` through -- non-empty, but not
    // remotely an ISO timestamp -- so `isValidIsoTimestamp` enforces the real
    // shape and value, not merely "some text was here".
    if (!isValidIsoTimestamp(raw.removed_at)) {
      errors.push(
        `${where}.removed_at, when present, must be a non-empty ISO timestamp string ` +
          `(got ${JSON.stringify(raw.removed_at)}) -- a malformed tombstone must not be able ` +
          `to read as a live row`,
      );
    }
  }
}

// Validate a parsed `index.json`. Returns every error rather than the first, so
// a hand-edited file reports all its problems in one run.
export function validateDocumentIndex(raw: unknown): SchemaResult<DocumentIndex> {
  const errors: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, errors: ["index.json must be a JSON object"] };
  }
  if (raw.schema_version !== DOCUMENTKB_SCHEMA_VERSION) {
    // FAIL CLOSED. A newer file rewritten by this writer would lose whatever
    // fields the newer schema added, so refusing is the non-destructive answer.
    return {
      ok: false,
      errors: [
        `index.json schema_version must be ${DOCUMENTKB_SCHEMA_VERSION} ` +
          `(got ${JSON.stringify(raw.schema_version)}). This release refuses to read or ` +
          `rewrite an unsupported version rather than silently dropping fields it does ` +
          `not understand.`,
      ],
    };
  }
  if (!Array.isArray(raw.documents)) {
    return { ok: false, errors: ["index.json documents must be an array"] };
  }
  raw.documents.forEach((row, i) => {
    validateRow(row, `documents[${i}]`, errors);
  });

  // Duplicate ids: lookups are BY id, so every row after the first is
  // unreachable. Reported with the offending id so the human can find it.
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const row of raw.documents) {
    if (isObject(row) && typeof row.id === "string") {
      if (seen.has(row.id)) dupes.add(row.id);
      seen.add(row.id);
    }
  }
  for (const id of dupes) {
    errors.push(
      `duplicate document id ${id} — lookups are by id, so all but the first row ` +
        `would be silently unreachable`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as DocumentIndex };
}

// Validate a parsed per-document `metadata.json`. Same treatment as the index:
// it is the REBUILD input, and a rebuild that trusts its input is an
// arbitrary-file-read with extra steps.
export function validateDocumentMetadata(raw: unknown): SchemaResult<DocumentMetadata> {
  const errors: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, errors: ["metadata.json must be a JSON object"] };
  }
  if (raw.schema_version !== DOCUMENTKB_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `metadata.json schema_version must be ${DOCUMENTKB_SCHEMA_VERSION} ` +
          `(got ${JSON.stringify(raw.schema_version)})`,
      ],
    };
  }
  validateRow(raw, "metadata.json", errors);
  if (raw.content_trust !== "untrusted") {
    errors.push(
      `metadata.json content_trust must be "untrusted" — extracted text is data, ` +
        `never instructions, and the framing is recorded at write time`,
    );
  }
  if (raw.content_handling !== "data-not-instructions") {
    errors.push(`metadata.json content_handling must be "data-not-instructions"`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as DocumentMetadata };
}

// Is this derivative still valid for the row's CURRENT digest? A mismatch means
// the original was edited without re-extracting, so the text on disk describes a
// revision that no longer exists and MUST NOT be served.
export function derivativeIsCurrent(row: DocumentRow): boolean {
  if (row.extraction.state !== "extracted") return false;
  return row.extraction.source_revision === row.sha256;
}

// The effective state a READER should act on. Distinct from the stored state:
// storage records what extraction produced, this reports whether it is still
// true of the current bytes. `invalidated` is therefore derivable, not just a
// value a writer may set.
export function effectiveExtractionState(row: DocumentRow): ExtractionState {
  if (row.extraction.state === "extracted" && !derivativeIsCurrent(row)) {
    return "invalidated";
  }
  return row.extraction.state;
}

// A tombstoned row: the original is gone. Excluded from retrieval, but still
// listed and still citable.
export function isTombstoned(row: DocumentRow): boolean {
  return typeof row.removed_at === "string" && row.removed_at.length > 0;
}

// Is the SUMMARY still valid for the row's CURRENT digest? Mirrors
// `derivativeIsCurrent` exactly (S3 design §3.1c: "Extraction/summary
// derivatives are revision-bound") -- a summary is an LLM-authored derivative
// of the same source bytes extraction is, so it fails the same way: a summary
// produced from a since-edited original describes a revision that no longer
// exists and MUST NOT be served.
export function summaryIsCurrent(row: DocumentRow): boolean {
  if (isTombstoned(row)) return false;
  if (row.summary.state !== "generated") return false;
  return row.summary.source_revision === row.sha256;
}

// The effective summary state a READER should act on, distinct from the
// stored one for the identical reason `effectiveExtractionState` is distinct
// from `row.extraction.state`: storage records what was generated, this
// reports whether it is still true of the current bytes. A `generated`
// summary whose source_revision no longer matches is reported as
// `invalidated` here even though `SummaryRecord`'s own two-state union (S3a,
// shipped and reviewed) has no literal `"invalidated"` member -- this is a
// DERIVED reader-facing state, exactly as `effectiveExtractionState` derives
// `"invalidated"` from a `state: "extracted"` union member that also lacks it.
export function effectiveSummaryState(row: DocumentRow): "absent" | "generated" | "invalidated" {
  if (isTombstoned(row)) return "absent";
  if (row.summary.state === "generated" && !summaryIsCurrent(row)) return "invalidated";
  return row.summary.state;
}
