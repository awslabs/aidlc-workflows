# Corner Checklist

Most defects that survive a careful requirements pass are not missing
features. They are **corners**: one component meeting one unusual condition
(an empty list, a path with two spellings, a value containing the format's own
delimiter, a store that is briefly unreachable). Nobody thinks to ask about
them, so asking more questions does not find them. Sweeping each component
against a fixed list of conditions does.

This checklist is that list. It applies wherever requirements, acceptance
criteria, or functional behaviour are written or reviewed.

## How to Use It

1. **Fix the deployment shape first.** Who else can see or change this data?
   Is it single-user or multi-user, local or networked, one tenant or many? A
   single-user local tool skips most of the identity, tenant, and
   personal-data rows; a regulated multi-tenant service keeps all of them.
2. **List the components.** Use the capabilities, screens, jobs, or
   integrations the request already names. Do not invent new ones.
3. **Cross each component with the surfaces it touches** (the headings below).
   A component that never reads files skips "Files and paths".
4. **For each condition that applies, settle it one of three ways:**
   - write the expected behaviour as a requirement or a Given/When/Then
     acceptance criterion;
   - record it under **Assumptions** with the reason it needs no requirement;
   - record it under **Out of scope**.
5. **Ask the person only what the agent cannot know.** Facts about the
   person's own world (team, budget, accounts, Regions, existing systems,
   compliance obligations) are always asked. A corner the agent can settle
   with a sensible default is written as a requirement or an assumption the
   person can correct, not turned into a question.

The bar: every applicable condition ends as a requirement, an assumption with
a reason, or an explicit exclusion. A corner left silent is the one that ships
broken.

## Conditions by Surface

Each line is a condition, then what must be true.

### Files and paths
- **Missing path**: names the path, says it is missing, keeps doing the rest.
- **Permission denied**: reports which path and why; the rest keeps working.
- **Two spellings of one path** (case, Unicode normalization, trailing slash, symlinked parent): treated as one item, never counted twice.
- **Odd names** (spaces, quotes, non-ASCII, very long, reserved): handled exactly like plain names.
- **Escaping the root** (symlink, `..`, archive entry): never reads or writes outside the intended directory; stops on loops.
- **Half-written file**: never read as complete; own writes are atomic (write then rename).
- **Disk full or read-only**: the write fails clearly, the previous good data survives, no false success.
- **Unknown files** (OS metadata, editor swap files, partial downloads): ignored or reported, never parsed as data.
- **Changed after check**: a file changed since it was indexed is re-read or reported stale.

### Formats the product parses
- **One malformed record among good ones**: skipped and counted; every valid record still processed.
- **Truncated or still-growing input**: the last partial record is "not yet complete", not an error and not data.
- **Unknown, missing, or renamed fields**: keeps working on what it understands and flags the rest.
- **Delimiters, quotes, or newlines inside values**: survive parsing and writing unchanged.
- **Encodings** (BOM, CRLF, invalid bytes): read without corrupting text or failing the whole input.
- **Empty input**: shown as "no data", distinct from a failed read.
- **Duplicate keys or repeated records**: one documented rule decides; nothing counted twice.
- **Hostile input** (entity expansion, unsafe deserialization, archive bombs): parsed with safe settings and limits.
- **Assumed external structure**: any assumption about how another tool lays out its data (nesting depth, naming, ordering) is written down and checked against real data.

### Text
- **Empty or whitespace-only**: treated consistently; a placeholder appears where a blank would mislead.
- **Very long text or one unbroken word**: stored and shown without breaking layout or limits.
- **Emoji, combining marks, right-to-left, invisible characters**: counted, truncated, and compared by visible character.
- **Markup or control sequences**: escaped for the destination (HTML, terminal, spreadsheet formulas), never executed.
- **Looks equal but is not**: one documented rule for case, whitespace, and normalization when comparing.

### Numbers, units, and money
- **Zero or empty denominator**: a defined value such as "n/a", never NaN or a crash.
- **Boundaries** (0, 1, negative, maximum, inclusive vs exclusive): correct at and just past each limit.
- **Rounding**: shown parts add up to the shown total, or the difference is labelled.
- **Units**: every quantity carries its unit; conversions happen in one place.
- **Unknown vs zero**: "unknown", "not applicable", and "0" stay distinct end to end.
- **Money**: integer minor units or fixed-point decimals with a currency; never floating point.
- **No known price or rate**: shown as unknown and flagged, never treated as free.
- **Estimates**: labelled as estimates with their basis, never shown as billed amounts.

### Time
- **Time zones and daylight saving**: instants stored with offset; day boundaries in one stated zone.
- **Clock skew**: durations use a monotonic clock and are never negative.
- **Period edges**: inclusive or exclusive ends stated; correct across midnight, month end, leap day, year end.
- **Ties and out-of-order events**: ordered by timestamp, then a stable tiebreaker.
- **Implausible timestamps** (missing, epoch zero, far future): flagged as suspect, not shown as real events.
- **Expiry and deadlines**: one trusted clock; defined behaviour exactly at the deadline.

### Identity of things
- **Two things share a name or key**: kept separate, with enough context to tell them apart.
- **One thing under several names** (renamed, moved, synced from two sources): merged or linked, never double-counted.
- **Dangling reference**: shown as broken or archived; dependent data is kept.
- **Records with no owner**: assigned to an explicit, visible "unattributed" bucket so totals reconcile.
- **External ids**: treated as opaque strings (leading zeros, case, and length preserved).

### Collections and lists
- **Empty**: says so, says why if known (none exist, filtered out, no access), offers the next action.
- **Exactly one item**: singular wording; charts and averages still make sense.
- **Very many items**: stays responsive by paging, virtualizing, or summarizing; any cap is stated.
- **Some sources failed**: shows what loaded and what did not; partial totals are never shown as complete.
- **Ordering**: a defined order with a deterministic tiebreaker.
- **Group totals**: subtotals add up to the grand total; items in several groups or none follow a stated rule.

### Network and remote services
- **Slow or hanging call**: every call has a timeout; only the dependent feature degrades.
- **Offline or service down**: says so, keeps local work usable, recovers on its own.
- **Error status or unexpected body**: status and content type checked before use.
- **Retries**: never repeat a side effect (idempotency keys, capped backoff with jitter).
- **Rate limited**: honours the limit, slows down, tells the user when results are delayed.
- **Version skew with the other side**: tolerates added fields; its own API is versioned.

### Storage and state
- **Store unavailable**: reports the failure, loses no accepted write, recovers without a manual restart.
- **Multi-step write interrupted**: all or nothing.
- **Concurrent edits**: no change silently lost; the conflict is detected and merged or put to the user.
- **Two copies of one fact**: one copy is the declared source of truth; disagreements are detected and repaired.
- **Cache vs source**: a stated freshness bound; the source wins.
- **Migration and upgrade**: existing data and settings survive; old and new versions can coexist during rollout; rollback keeps data readable.

### Concurrency, jobs, and sessions
- **Two actors on the same item at once**: same result as running one after the other.
- **Job runs twice or overlaps itself**: never concurrent with itself; running twice equals running once.
- **Killed mid-work** (crash, sleep, cancel): restarts cleanly with no half-applied results.
- **Stuck work**: a timeout or heartbeat detects it and releases it.
- **Older response arrives last**: only the latest request's result is applied.
- **Same user in several tabs or devices**: actions in one are reflected or safely rejected in the others.
- **Feedback loop**: state derived from data never changes the data or view it is derived from in a way that re-triggers itself (flapping status, re-render or remount loops).

### Screens and user input
- **Loading, empty, and error** are three different views, each saying what happened and what to do next.
- **Stale data**: shows when it was last updated and when a refresh failed.
- **Same fact in two places**: same value, same units, same rounding, updated together.
- **Destructive action**: confirmation naming what is affected, or undo.
- **Invalid input**: names the field and the fix, keeps everything the user typed.
- **Double submit**: never creates duplicates.
- **Unsaved input on navigation or session expiry**: never silently discarded.
- **Client-side rules**: also enforced on the trusted side.
- **Keyboard, screen reader, contrast, zoom**: every function works by keyboard; status is never shown by color alone.

### Configuration, build, and environment
- **Missing or invalid setting**: a documented default, or a startup error naming the key and the expected form.
- **Several sources disagree** (defaults, file, environment, flags, user): one documented precedence; the effective value can be shown.
- **Works locally, fails in CI or production**: builds and passes from a clean checkout with pinned toolchain versions; the tested artifact is the deployed one.
- **Supported platforms**: OS, runtime, and browser versions are declared and checked, with a clear message otherwise.
- **First run**: works with no prior data, cache, or configuration.
- **Third-party tool missing, changed, or hanging**: says which one and how to fix it; machine-readable output and exit codes only; every subprocess has a timeout.

### Identity, security, and personal data
Apply only after the deployment-shape step says they are relevant.
- **Session expires mid-flow**: work resumes after re-authentication without loss.
- **Per-object authorization**: every read and write checks the caller's right to that object, including list, search, and export.
- **Rights revoked while signed in**: enforced within a stated, short window.
- **Tenant isolation**: no query, cache key, file path, log, or job crosses tenants.
- **Secrets**: loaded at runtime from a protected store, never logged or shown, rotatable.
- **Sensitive data in logs, URLs, notifications, or exports**: excluded or masked.
- **Retention and erasure**: only needed data is kept, for a stated period, and can be exported or erased on request.

### AI and agent output
- **Malformed output**: validated against the expected structure; failures retried or surfaced.
- **Ungrounded claims**: tied to identified sources or marked as uncertain.
- **Untrusted content steering the model**: delimited; it cannot change instructions or permissions.
- **Context limit exceeded**: chunked or refused explicitly; never silently truncated.
- **Consequential actions**: permission-scoped, logged, and confirmed by a person.

## Growing the List

When a defect reaches testing or production and no condition here describes
it, add the condition to the team's own knowledge
(`aidlc/spaces/<active-space>/knowledge/aidlc-product-agent/`) so the next
intent sweeps for it. The list improves from real findings, not from more
questions.
