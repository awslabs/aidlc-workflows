// covers: file:aidlc-common/stages/inception/reverse-engineering.md, file:aidlc-common/stages/inception/requirements-analysis.md, file:aidlc-common/stages/inception/practices-discovery.md, file:aidlc-common/stages/inception/user-stories.md, file:aidlc-common/stages/construction/nfr-requirements.md
//
// t154 — codekb promotion. Deterministic, no-LLM, zero-token structural
// contract over the SHIPPED stage files: P0 promoted the reverse-engineering
// stage's outputs from the buried per-workflow path
// `aidlc-docs/inception/reverse-engineering/` to the durable per-repo code
// knowledge base, and re-pointed its verified downstream consumers to read from
// the new location. The codekb-determinism placement fix then made that store
// SPACE-SCOPED — `aidlc/spaces/<active-space>/codekb/<repo>/` (a sibling of
// intents/), the dir the `codekb-path` tool resolves — so the prose now names
// the space-level literal and the bare `aidlc/codekb/<repo>/` form is gone.
//
// Mechanism: none. We read the shipped dist/claude stage .md files in-process
// (the same AIDLC_SRC tree t05/t87 resolve) and parse frontmatter via the
// public parseStageFrontmatter (aidlc-lib.ts:1161). No process boundary, no
// argv/exit/stdout seam, no live agent. The runtime artifact-path RESOLVER
// (aidlc-orchestrate.ts resolveArtifactPath/resolveConsumePath) is a SEPARATE
// concern owned by P1 and is NOT exercised here — at P0 the change lives at the
// stage-document layer (where the RE agent reads its write destination and the
// consumers read their upstream path).
//
// CONTRACT under test (path literal = `aidlc/spaces/<active-space>/codekb/<repo>/`):
//   1. RE stage `outputs:` names the space-level codekb path and KEEPS its 9 .md
//      artifact filenames (the filenames `aidlc-validate outputs` cross-checks
//      against the body prose, aidlc-validate.ts:51-94 — t45's invariant).
//   2. RE stage body prose writes its artifacts to the space-level codekb path.
//   3. The freshness/staleness marker `reverse-engineering-timestamp` is
//      preserved in `produces:` (the marker a shared per-repo codekb needs;
//      vision §7) and the `condition` still names "rerun for freshness".
//   4. The TWO frontmatter consumers still declare the `reverse-engineering`
//      dependency edge under `requires_stage:` (the edge is untouched — only
//      the read PATH moved), and requirements-analysis's RE-read prose points
//      at the space-level codekb path. (practices-discovery references RE
//      artifacts BY NAME, not by output path — it carries no RE output-path
//      prose to re-point, so only its `requires_stage:` edge is asserted.)
//   5. The TWO prose consumers (user-stories, nfr-requirements) point their
//      RE-read prose at the space-level codekb path.
//   6. NO stage file retains the old RE output directory literal
//      `aidlc-docs/inception/reverse-engineering/` NOR the bare
//      `aidlc/codekb/<repo>/` form anywhere.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { parseStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude — the shipped tree (fixtures.ts:42),
// the same one t05/t87 read. Assert on the DIST output so a stale dist (a core
// edit not re-packaged) is caught here as well as by `package.ts --check`.
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");
// Knowledge tree (per-agent reference docs). RE artifact templates live here
// (aidlc-developer-agent/re-artifacts.md), so the bare-codekb sweep must cover
// it too — a stale shorthand here is live knowledge the RE stage reads, and it
// previously escaped because the sweep was stages-only.
const KNOWLEDGE_DIR = join(AIDLC_SRC, "knowledge");

// The codekb store is a SPACE-LEVEL sibling of intents/ — the engine resolves it
// to `aidlc/spaces/<space>/codekb/<repo>/` and the stage prose names it with the
// `<active-space>` token (the live cursor a literal can't hard-code). The RE
// stage + its consumers carry THIS literal, deferring the concrete dir to the
// `codekb-path` tool. (Was the bare `aidlc/codekb/<repo>/` before the
// codekb-determinism placement fix; the bare form must no longer appear, asserted
// by NO_BARE_CODEKB_PATH below.)
const NEW_CODEKB_PATH = "aidlc/spaces/<active-space>/codekb/<repo>/";
const OLD_RE_OUTPUT_PATH = "aidlc-docs/inception/reverse-engineering/";
// The bare workspace-root form the placement fix replaced — it must NOT survive
// in any stage prose now that codekb is space-scoped.
const NO_BARE_CODEKB_PATH = "aidlc/codekb/<repo>/";

// The 9 RE artifact filenames the stage produces — kept inside the `outputs:`
// parens so aidlc-validate's filename-vs-body cross-check (t45) still passes.
const RE_ARTIFACT_FILES = [
  "business-overview.md",
  "architecture.md",
  "code-structure.md",
  "api-documentation.md",
  "component-inventory.md",
  "technology-stack.md",
  "dependencies.md",
  "code-quality-assessment.md",
  "reverse-engineering-timestamp.md",
];

function stageBody(phase: string, slug: string): string {
  return readFileSync(join(STAGES_DIR, phase, `${slug}.md`), "utf8");
}

function stageFrontmatter(phase: string, slug: string): Record<string, unknown> {
  return parseStageFrontmatter(stageBody(phase, slug)) as Record<string, unknown>;
}

describe("t154 codekb promotion — RE outputs land at aidlc/spaces/<active-space>/codekb/<repo>/", () => {
  // ── 1: RE stage outputs re-pointed, filenames preserved ──────────────────
  test("reverse-engineering `outputs:` names the space-level codekb path (not the old buried path)", () => {
    const fm = stageFrontmatter("inception", "reverse-engineering");
    const outputs = fm.outputs as string;
    expect(outputs).toContain(NEW_CODEKB_PATH);
    expect(outputs).not.toContain(OLD_RE_OUTPUT_PATH);
  });

  test("reverse-engineering `outputs:` still enumerates all 9 RE artifact filenames", () => {
    const outputs = stageFrontmatter("inception", "reverse-engineering").outputs as string;
    for (const f of RE_ARTIFACT_FILES) {
      expect(outputs, `outputs: missing artifact filename ${f}`).toContain(f);
    }
  });

  // ── 2: RE body prose writes to the space-level codekb dir ────────────────
  test("reverse-engineering body prose writes artifacts to aidlc/spaces/<active-space>/codekb/<repo>/", () => {
    const body = stageBody("inception", "reverse-engineering");
    // The prose names the space-level store (backtick-wrapped) and defers the
    // concrete dir to `codekb-path`; neither the old record path nor the bare
    // workspace-root codekb form survives.
    expect(body).toContain(`\`${NEW_CODEKB_PATH}\``);
    expect(body).not.toContain(OLD_RE_OUTPUT_PATH);
    expect(body).not.toContain(NO_BARE_CODEKB_PATH);
  });

  // ── 3: the freshness marker is preserved as the staleness gate ───────────
  test("reverse-engineering keeps reverse-engineering-timestamp in produces: and stays a freshness rerun", () => {
    const fm = stageFrontmatter("inception", "reverse-engineering");
    expect(fm.produces as string[]).toContain("reverse-engineering-timestamp");
    expect((fm.condition as string).toLowerCase()).toContain("freshness");
  });

  // ── 4: frontmatter consumers — edge intact, read path re-pointed ─────────
  test("requirements-analysis keeps the reverse-engineering requires_stage edge", () => {
    const fm = stageFrontmatter("inception", "requirements-analysis");
    expect(fm.requires_stage as string[]).toContain("reverse-engineering");
  });

  test("requirements-analysis RE-read prose resolves aidlc/codekb/<repo>/ (not the old path)", () => {
    const body = stageBody("inception", "requirements-analysis");
    expect(body).toContain(`Read RE artifacts from \`${NEW_CODEKB_PATH}\``);
    expect(body).not.toContain(OLD_RE_OUTPUT_PATH);
  });

  test("practices-discovery keeps the reverse-engineering requires_stage edge", () => {
    const fm = stageFrontmatter("inception", "practices-discovery");
    expect(fm.requires_stage as string[]).toContain("reverse-engineering");
  });

  // ── 5: prose consumers re-pointed ────────────────────────────────────────
  test("user-stories RE-read prose resolves aidlc/codekb/<repo>/ (not the old path)", () => {
    const body = stageBody("inception", "user-stories");
    expect(body).toContain(`Read relevant RE artifacts from \`${NEW_CODEKB_PATH}\``);
    expect(body).not.toContain(OLD_RE_OUTPUT_PATH);
  });

  test("nfr-requirements RE-read prose resolves aidlc/codekb/<repo>/ (not the old path)", () => {
    const body = stageBody("construction", "nfr-requirements");
    expect(body).toContain(`reverse engineering artifacts from \`${NEW_CODEKB_PATH}\``);
    expect(body).not.toContain(OLD_RE_OUTPUT_PATH);
  });

  // ── 6: no stage file retains the OLD RE output dir NOR the bare codekb form ──
  // Sweep every shipped stage .md for BOTH retired literals: the pre-promotion
  // record-dir path AND the bare workspace-root `aidlc/codekb/<repo>/` the
  // codekb-determinism placement fix replaced with the space-scoped form.
  test("no shipped stage .md retains the old aidlc-docs/inception/reverse-engineering/ NOR the bare aidlc/codekb/<repo>/ path", () => {
    const oldOffenders: string[] = [];
    const bareOffenders: string[] = [];
    for (const phase of readdirSync(STAGES_DIR).sort()) {
      const phaseDir = join(STAGES_DIR, phase);
      if (!statSync(phaseDir).isDirectory()) continue;
      for (const entry of readdirSync(phaseDir).sort()) {
        if (!entry.endsWith(".md")) continue;
        const path = join(phaseDir, entry);
        const body = readFileSync(path, "utf8");
        if (body.includes(OLD_RE_OUTPUT_PATH)) oldOffenders.push(`${phase}/${entry}`);
        if (body.includes(NO_BARE_CODEKB_PATH)) bareOffenders.push(`${phase}/${entry}`);
      }
    }
    expect(oldOffenders).toEqual([]);
    expect(bareOffenders).toEqual([]);
  });

  // ── 7: the bare codekb form must not survive in the KNOWLEDGE tree either ──
  // RE artifact templates (aidlc-developer-agent/re-artifacts.md) are live
  // knowledge the RE stage reads; the bare `aidlc/codekb/<repo>/` shorthand
  // previously lingered here because test 6 swept only stages. Walk the whole
  // knowledge tree (nested per-agent) so the space-scoped contract holds there too.
  test("no shipped knowledge .md retains the bare aidlc/codekb/<repo>/ path", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir).sort()) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (entry.endsWith(".md") && readFileSync(path, "utf8").includes(NO_BARE_CODEKB_PATH)) {
          offenders.push(path.slice(KNOWLEDGE_DIR.length + 1));
        }
      }
    };
    walk(KNOWLEDGE_DIR);
    expect(offenders).toEqual([]);
  });
});
