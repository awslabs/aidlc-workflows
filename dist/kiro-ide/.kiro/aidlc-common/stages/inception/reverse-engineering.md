---
slug: reverse-engineering
phase: inception
execution: CONDITIONAL
condition: Execute when project is brownfield. On rerun the Step 1 guard checks store freshness (codekb-scope-diff) - verified-CURRENT stores may be reused by human choice, anything else rescans. Skip for greenfield projects.
lead_agent: aidlc-developer-agent
support_agents:
  - aidlc-architect-agent
mode: pipeline
produces:
  - business-overview
  - architecture
  - code-structure
  - api-documentation
  - component-inventory
  - technology-stack
  - dependencies
  - code-quality-assessment
  - reverse-engineering-timestamp
consumes: []
requires_stage:
  - state-init
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - poc
  - bugfix
  - refactor
  - security-patch
  - classic
  - workshop
  - express
inputs: <record>/aidlc-state.md
outputs: "aidlc/spaces/<active-space>/codekb/<repo>/ (9 artifacts: business-overview.md, architecture.md, code-structure.md, api-documentation.md, component-inventory.md, technology-stack.md, dependencies.md, code-quality-assessment.md, reverse-engineering-timestamp.md)"
---

# Reverse Engineering

This stage runs `mode: pipeline` (stage-protocol-ensemble.md §5): a two-link chain in
which each link advances the work product directly. The developer lead (link
1) scans and returns structured results; the architect (link 2, the final
link) synthesizes those results and writes the 9 artifacts. The final link
leaving the `produces[]` artifacts complete plus both tool-owned link receipts
is the pipeline contract — no contribution files on pipeline stages. On resume,
read `directive.pipeline.completed` and dispatch only the first missing link;
multi-repo entries are qualified as `<repo>:<agent>`.

## Steps

### Step 1: Check Conditions

Read `<record>/aidlc-state.md` to confirm:
- Project type is brownfield

If the project is not brownfield, run
`bun .kiro/tools/aidlc-orchestrate.ts report --stage reverse-engineering --result skipped --reason "<reason>"`.
The engine records the skip and advances to the next in-scope stage.

#### Resolve the intent's repo set (multi-repo)

This stage runs **per repo** the intent touches. Resolve the complete repo set
from the intent's registry row before making any reuse or scan decision:

1. Read the active intent's `repos` array from
   `aidlc/spaces/<active-space>/intents/intents.json` (the row whose `uuid`/`slug`
   matches the active intent). This is the set captured at intent creation (an explicit
   `--repos a,b` or sibling auto-discovery).
2. **Unrecorded project-root repo:** if `repos` is absent or empty, RE runs once
   against the workspace root. Its handoff and receipts omit repo qualification.
3. **Registered repos (one or more):** resolve the Step 1 guard decision for
   every recorded repo, then run Steps 2-3 once for each repo selected for a
   scan. Scan that repo's sibling directory (`<workspace>/<repo>/`), qualify its
   handoff and both receipts with that exact repo identity, and write its 9
   artifacts to the directory `codekb-path --repo <repo>` prints (the
   space-level `aidlc/spaces/<active-space>/codekb/<repo>/`; see Step 3). Each
   repo's codekb is independent, so selected scans may run as parallel subagents.

In the steps below, `<repo>` is the repository whose decision or scan is being
processed.

For each repo selected for scanning, Steps 2-3 are one independent receipt
chain. Add `--repo <repo>` to both receipt commands whenever the intent records
that repo identity, including an exactly-one repo set. Omit it only for an
unrecorded project-root repo.

#### Rerun guard: check each existing store before scanning

The codekb is a space-level store shared across intents. A full rescan REPLACES
all 9 artifacts; a focused scan MERGES into the existing store so knowledge
accumulates across intents. For every repo in the resolved set, run the
read-only check:

```
bun .kiro/tools/aidlc-utility.ts codekb-scope-diff --repo <repo>
```

- **NO_STORE** - first scan for this repo. Proceed to Step 2; no question.
- **CURRENT** - the store's analyzed paths are unchanged since it was built.
  If the recorded coverage plausibly serves this intent's area, present the
  reuse question below. If this intent clearly targets code OUTSIDE the
  store's analyzed paths, skip the reuse option and ask rescan vs focused only.
- **STALE / UNVERIFIED / UNKNOWN_SCOPE** - the store's knowledge is out of
  date, unverifiable, or predates scope tracking. Present the rescan question
  below WITHOUT the reuse option.

Reuse question (CURRENT + coverage fits the intent) - fold the tool's output
(store intent, analyzed paths) into the prompt so the human decides on
evidence:

```question
prompt: "An up-to-date code knowledge base exists for <repo> (built by intent <store-intent>; verified unchanged). Deep coverage: <analyzed paths>. Reuse it, or rescan?"
header: "Code KB"
multiSelect: false
options:
  - label: "Reuse existing knowledge base"
    description: "Skip the scan; downstream stages read the current store as-is"
  - label: "Full rescan"
    description: "Rebuild the store covering the whole repo (replaces all 9 artifacts)"
  - label: "Focused scan"
    description: "Scan this intent's area and extend the store; preserve prior prose outside it, demoting unverifiable deep coverage to shallow"
```

Rescan question (STALE / UNVERIFIED / UNKNOWN_SCOPE, or CURRENT with coverage
that does not fit) - include the verdict line in the prompt:

```question
prompt: "A code knowledge base exists for <repo> but <verdict summary - e.g. its analyzed paths have changed since it was built / it does not cover this intent's area>. A full rescan replaces it; a focused scan merges into it. How should the scan run?"
header: "Code KB"
multiSelect: false
options:
  - label: "Full rescan"
    description: "Rebuild the store covering the whole repo (replaces all 9 artifacts)"
  - label: "Focused scan"
    description: "Scan this intent's area and extend the store; preserve prior prose outside it, demoting unverifiable deep coverage to shallow"
```

Record one decision per repo: reuse, full rescan, or focused scan. A reuse
decision does NOT report or advance the stage while another repository may
still need scanning. On a scan choice, also record its breadth; that choice
sets the developer brief, and Step 3's scope block records what the scan
actually covered.

Immediately after each human reuse decision, record that repo's
current-attempt exemption:

```
bun .kiro/tools/aidlc-state.ts reuse-artifact reverse-engineering --decision keep --artifacts "<codekb-path output>" [--repo <repo>] [--single]
```

Use one row per reused registered repo. For an unrecorded single-repo workspace,
omit `--repo`. On an isolated run (`directive.single === true`), add `--single`;
the tool verifies the complete canonical nine-artifact store is present and
still `CURRENT`, binds the row to this synthetic attempt, and the completion
check independently re-verifies artifact authority and freshness before
accepting it.

Immediately before Step 2, take one compare-and-swap snapshot for every repo
selected for scanning:

```
bun .kiro/tools/aidlc-utility.ts codekb-snapshot --repo <repo> --paths <source paths> --json
```

Choose `<source paths>` as follows:

- Full rescan: `./`.
- Focused scan of a CURRENT store: the union of the store's existing
  `analyzed.paths` and the intended focused paths. A full store therefore uses
  `./`.
- Focused scan of a STALE, UNVERIFIED, UNKNOWN_SCOPE, or NO_STORE store: the
  intended focused paths.

Keep the returned `store_generation`, `source_fingerprint`, and `paths` keyed
by repo. They bind synthesis to both the exact shared CodeKB generation and the
source bytes the scan is about to inspect. If the developer later reports an
`analyzed.paths` entry outside the snapshot's `paths`, discard that result and
repeat the snapshot plus scan over the expanded path set; never widen verified
coverage after the scan without a matching pre-scan source snapshot.

Only after every repository decision has been resolved:

- If every repo is reused on an ordinary workflow run, report the stage as
  skipped exactly once:
  `bun .kiro/tools/aidlc-orchestrate.ts report --stage reverse-engineering --result skipped --reason "codekb reuse: all resolved stores CURRENT, human chose reuse"`.
- If every repo is reused on an isolated run (`directive.single === true`), do
  NOT call the main-workflow skipped report. Return the reused-repositories
  summary to the orchestrator's isolated stage-runner branch; the single-run
  reuse rows satisfy its pipeline evidence, and it owns the single
  `report --single --stage "reverse-engineering" --result completed`.
- If any repo needs scanning, do not report a skip. Proceed to Steps 2-3 for
  only the full/focused scan repos; leave each reused repo's store unchanged.
  The reuse rows exempt those repos while scanned repos still require both
  links. On an isolated run, add `--single` to every link receipt command below.

### Step 2: Developer Code Scan

Delegate to Task tool with aidlc-developer-agent:
- subagent_type="aidlc-developer-agent"
- The agent persona and knowledge are loaded automatically. Do NOT manually inject the persona.
- Include workspace state from aidlc-state.md as context

The conductor owns the store/reuse decision but does NOT inspect application
source, enumerate the repo, or precompute the file list before this dispatch.
That duplicates the developer link. Give the developer the repo root, the
intent, the chosen breadth, the active Minimal/Standard/Comprehensive depth,
and the exact handoff path below; the developer discovers the source surface.

Brief the developer with the scan breadth chosen at the Step 1 guard (full
rescan = the whole repo; focused scan = the intent's area, named explicitly in
the brief) and require the scan results' Scan Coverage section (re-artifacts.md
template) to list what was actually analyzed deeply vs skimmed. Include the
repo's snapshot `paths`; the deeply analyzed result MUST stay within that set.

For each repo selected for scanning, the developer scans `<repo>`'s codebase
(the sibling dir `<workspace>/<repo>/`; for a single-repo intent this is the
whole codebase) for:
- All packages, modules, and their purposes
- Build systems, configuration, and dependency relationships
- External and internal APIs (endpoints, contracts, methods)
- Frameworks, libraries, and their versions
- Test directories, test frameworks, coverage configuration
- Code quality indicators (linting, CI/CD, documentation)
- Technical debt signals

Developer writes the structured scan results following the Developer Code Scan
Template in `.kiro/knowledge/aidlc-developer-agent/re-artifacts.md`:

- Unrecorded project-root repo:
  `<record>/inception/reverse-engineering/developer-scan.md`
- Registered repo (including an exactly-one repo set):
  `<record>/inception/reverse-engineering/developer-scan-<repo>.md`

This file is the durable pipeline handoff. The developer's return summary names
the handoff path and any concerns only; it does not repeat the scan body.

After the developer return has been read, verify the handoff file exists and
contains `## Developer Code Scan Results`, `### Scan Coverage`, and
`## Handoff Summary`. Then mint link 1 before dispatching the architect:

```
bun .kiro/tools/aidlc-log.ts link --stage reverse-engineering --link aidlc-developer-agent --artifact "<developer scan handoff path>" [--repo <repo>] [--single]
```

The logger requires the handoff to have been written in the current stage
attempt and binds the receipt to its path, write time, and SHA-256. A
rejection/resume cannot reuse the old file, and any edit after the receipt
invalidates this link plus every downstream pipeline link until the developer
and architect run again.

### Step 3: Architect Synthesis

Delegate to Task tool with aidlc-architect-agent:
- subagent_type="aidlc-architect-agent"
- The agent persona and knowledge are loaded automatically. Do NOT manually inject the persona.
- Pass the developer scan handoff path, not its body; the architect reads that file
- Include workspace state from aidlc-state.md

Architect synthesizes scan results into a complete 9-artifact candidate:
1. **business-overview.md** — Business domain, purpose, key functionality
2. **architecture.md** — System architecture, patterns, component relationships (with Mermaid diagrams). MUST include Interaction Diagrams section depicting how business transactions are implemented across components (sequence or flow diagrams).
3. **code-structure.md** — Package/module organization, file classification, code patterns
4. **api-documentation.md** — External and internal API surfaces, endpoints, contracts
5. **component-inventory.md** — Complete component list with responsibilities and dependencies
6. **technology-stack.md** — Languages, frameworks, libraries with versions
7. **dependencies.md** — External dependencies, internal cross-package dependencies
8. **code-quality-assessment.md** — Test coverage, linting, CI/CD, documentation quality, tech debt
9. **reverse-engineering-timestamp.md** - Records when reverse engineering was performed (date, commit hash if available) and MUST end with the structured `## Scope of Analysis` block from the re-artifacts.md template. Fill it from the developer's Scan Coverage and, for a focused merge, the existing store according to the rules below - it records what is ACTUALLY verified deeply, not what was aspired to. This is the freshness/staleness marker the Step 1 rerun guard reads.

Choose the write behavior recorded in Step 1:

- **Focused scan with an existing store (any verdict except NO_STORE):** before
  synthesis, read the existing 9 artifacts and the store's Scope of Analysis
  block. Update or extend sections that cover the newly analyzed area and
  preserve prior sections outside it; do not rebuild the artifacts solely from
  this run's focused results.
  - **CURRENT:** set `analyzed.paths` and `analyzed.components` to the union of
    the store and this run. A CURRENT `kind: full` store stays `kind: full` and
    keeps `./` in `analyzed.paths`; otherwise use `kind: partial` and never put
    `./` in a partial block.
  - **STALE / UNVERIFIED:** set `analyzed.paths` and `analyzed.components` from
    this run only. Preserve the prior prose, but demote the store's prior
    `analyzed.paths` into `shallow.paths` alongside the existing and newly
    reported shallow paths because that deep coverage could not be re-verified.
  - **UNKNOWN_SCOPE:** the legacy store has no usable prior scope block to
    union. Merge its prose best-effort, but record only this run in the new
    block.
- **Full rescan:** wholesale replace all 9 artifacts and build the scope block
  only from this run, unchanged from the existing full-rescan behavior.
- **NO_STORE:** create all 9 artifacts from this run. A focused first scan is
  `kind: partial`; `kind: full` is valid only when `analyzed.paths` includes
  `./`.

The architect MUST write the candidate into
`<record>/.aidlc-codekb-stage-<repo>/`, not into the
shared CodeKB. The staging directory contains exactly the nine filenames above
and no other entries. It is temporary transaction input, not a durable stage
artifact.

For the block's `fingerprint:` line, run the mint command with the final
`analyzed.paths` from the merged or replaced block (comma-separated) and paste
its output verbatim:

   ```
   bun .kiro/tools/aidlc-utility.ts codekb-scope-diff --repo <repo> --mint --paths <analyzed paths>
   ```

At Minimal depth, all nine artifacts and every required section above still
exist. Keep them concise by recording each inventory or finding once in its
owning artifact and cross-referencing it elsewhere instead of repeating the
same source list, dependency table, or persistence finding across files. This
is the methodology's existing depth contract, not an output-length cap.

**Resolve the final publish directory with the engine, do NOT compose the path
yourself.** Run the read-only tool

```
bun .kiro/tools/aidlc-utility.ts codekb-path --repo <repo>
```

(omit `--repo` only for an unrecorded project-root repo; pass it for every
registered repo identity, including an exactly-one repo set).
It prints ONE line: the exact final directory, e.g.
`aidlc/spaces/<active-space>/codekb/<repo>/`. Read an existing store from this
directory for a merge, but do not write the candidate there directly.

**Coverage backstop - run BEFORE writing (the compare needs the prior store
unchanged).** When the Step 1 guard found an existing store (any verdict but
NO_STORE), write the new or merged timestamp content to
`<record>/inception/reverse-engineering/scope-draft-<repo>.md` (one draft per
repo; NOT the timestamp filename - record-dir placement checks key on the
artifact stems) and run

```
bun .kiro/tools/aidlc-utility.ts codekb-scope-diff --repo <repo> --compare <record>/inception/reverse-engineering/scope-draft-<repo>.md
```

Keep the output keyed by `<repo>` for Step 5's completion summary. This is the
deterministic backstop for the requested breadth and the focused-merge rules:
COVERS means the incoming block preserved the prior verified coverage;
NARROWER identifies coverage that was demoted or lost. A focused run after a
"Full rescan" choice also surfaces here as NARROWER, before approval. Delete
that repo's `scope-draft-<repo>.md` immediately after preserving the compare
output; scope drafts are temporary and MUST NOT remain in the intent record.

Publish the complete candidate through the compare-and-swap utility, using the
exact snapshot values captured immediately before Step 2:

```
bun .kiro/tools/aidlc-utility.ts codekb-publish \
  --repo <repo> \
  --staged <record>/.aidlc-codekb-stage-<repo>/ \
  --paths <snapshot paths> \
  --expect-store <snapshot store_generation> \
  --expect-source <snapshot source_fingerprint> \
  --json
```

The utility validates all nine files and the candidate timestamp, acquires a
space+repo lock, rechecks the source and shared-store generations, then swaps
the complete staged directory into the final `codekb-path` location with
rollback/recovery. No other step may write those nine shared files.

- `CODEKB_STORE_CHANGED`: another intent published after this repo's snapshot.
  Re-run the Step 1 status check, read the new store, recompute the focused
  merge and scope union/demotion, take a fresh snapshot over the new candidate
  path set, and retry publication. The existing developer scan may be reused
  only when a fresh snapshot over the same paths returns the same
  `source_fingerprint`.
- `CODEKB_SOURCE_CHANGED`: source bytes changed after the pre-scan snapshot.
  Discard the staged candidate, take a fresh snapshot, and repeat Step 2 plus
  synthesis for that repo before retrying.
- `CODEKB_CANDIDATE_STALE`: the timestamp fingerprint was not minted from the
  source currently being published. Rebuild the candidate and retry.

Never bypass a refusal with direct writes or by substituting the newly observed
generation into the old candidate. After a successful publish, delete that
repo's `.aidlc-codekb-stage-<repo>/` directory. The final directory remains the
durable per-repo code knowledge base shared across every intent in the space.

After the architect return has been read and all 9 artifacts for that repo are
present, mint the final-link receipt:

```
bun .kiro/tools/aidlc-log.ts link --stage reverse-engineering --link aidlc-architect-agent [--repo <repo>] [--single]
```

Do not report completion until every selected repo's chain has both receipts.

### Step 4: Completion Handoff

After every selected repo scan has completed, hand completion to
`stage-protocol.md` exactly once via
`bun .kiro/tools/aidlc-orchestrate.ts report --stage reverse-engineering --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 5: Present Completion & Request Approval

Use stage-protocol.md completion template:
- Announcement with completion summary
- Summary of all 9 artifacts produced **per repo** (for a multi-repo intent, list
  each repo's `aidlc/spaces/<active-space>/codekb/<repo>/` set — the directory
  `codekb-path --repo <repo>` printed in Step 3); identify reused repos whose
  existing stores were left unchanged
- **For every repo whose Step 3 compare returned NARROWER**, the summary MUST
  carry a repo-labeled warning before the question, quoting that repo's tool
  coverage list verbatim:

  ```
  WARNING for <repo>: this scan's verified scope is narrower than the previous
  store. On a focused merge, prior prose is preserved, but deep coverage for
  the following paths and components was demoted (affected paths remain
  recorded as shallow):
  <paths and components from the compare output>
  Choose Request Changes to widen the scan instead.
  ```

  (COVERS, or no prior store, needs no warning line.)
- Review path: `aidlc/spaces/<active-space>/codekb/<repo>/` for each repo in the set
- Structured approval question with options: Approve (continue to Requirements Analysis) / Request Changes. If any repo returned NARROWER, the Approve option's description must say which stores now have narrower verified coverage (e.g. "Accept the narrower verified coverage for <repos>; continue to Requirements Analysis").

## Sensors

This stage's outputs are markdown artefacts under `aidlc/spaces/<active-space>/codekb/<repo>/` (the directory `codekb-path --repo <repo>` resolves).

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: none.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
