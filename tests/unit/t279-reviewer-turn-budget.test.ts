// covers: file:aidlc-common/protocols/stage-protocol.md §12a,
// file:agents/aidlc-architecture-reviewer-agent.md,
// file:agents/aidlc-product-lead-agent.md,
// file:skills/aidlc/SKILL.md reviewer bullet
//
// t279 - reviewer turn backstop + §12a incomplete-attempt guard. Field data
// (PR #613): at the medium-effort reviewer tier legitimate reviews ran p90 40
// / max 60 turns, so the authored `maxTurns: 60` is a true backstop - it
// catches runaways without truncating the observed legitimate tail. The cap
// is enforced natively where the harness has a lever - Claude Code reads the
// key verbatim (the sub-agent is stopped mid-task with no warning and no
// final-message turn), and the opencode emit renames it to the native
// per-agent `steps: 60` (at the cap the runner forces one final TEXT-ONLY
// turn: a summary can return, but no tool call can write the review file).
// Codex TOML personas, Cursor, Copilot, and Kiro CLI/IDE expose no per-agent
// cap key, so there the budget is persona prose only (the inert `maxTurns:`
// key still ships in the .md frontmatter surfaces that tolerate unknown
// keys; the codex TOML rewrites the persona's frontmatter citation instead,
// because a TOML persona has no frontmatter block for it to point at). The
// PERSONA text is deliberately harness-neutral: it states the cap
// unconditionally and plans for the worst-case cutoff, so the reviewer
// behaves identically everywhere.
//
// An uncapped-and-uninstructed reviewer death (turn cap, crash, context
// exhaustion) used to leave §12a step 3 reading a stale or missing review -
// an undefined branch. The guard this test pins:
//   - step 1 records the request before EVERY dispatch; the request opens the
//     review slot the reviewer writes (removing a draft an earlier incomplete
//     dispatch of the same iteration left), so "no review file" means
//     "incomplete review" uniformly on first entry and the Part 0 revision
//     path alike, and no stale pre-revision READY can be misread as covering
//     a revision; the reviewer writes that one file and never the artifact;
//   - step 3 validates exactly ONE review with exactly one canonical verdict
//     (READY | NOT-READY) and records it as the review record - a missing,
//     verdict-less, or duplicated review is an INCOMPLETE attempt, not a
//     verdict;
//   - an incomplete attempt retries the SAME unmatched request once via
//     `--retry-pending` (consuming no review iteration - on an advisory
//     stage the budget is exactly one pass, so counting a cut-off attempt
//     would burn the only review without ever obtaining findings);
//   - a second incomplete attempt records the terminal receipt
//     `--verdict NOT-READY` with the named finding, keeping the engine's
//     completion precondition satisfiable (the gate never deadlocks on a
//     silently missing verdict) and routing per review class.
//
// Mechanism: none. Pure content checks over authored + shipped bytes
// (dist trees beyond the asserted ones are byte-guarded by package.ts --check).
//
// Module note: the conditional-protocol-modules change carved §12a out of
// stage-protocol.md into stage-protocol-reviewer.md, and the harness SKILL
// reviewer bullets into a load-the-module pointer, so the §12a guard pins
// below read the reviewer MODULE (authored + per-harness dist copies) and the
// SKILL pins assert the module load line instead of inline prose.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const REVIEWERS = [
  "aidlc-architecture-reviewer-agent",
  "aidlc-product-lead-agent",
] as const;

const CAP = "60";
const REVIEWER_MODULE = "aidlc-common/protocols/stage-protocol-reviewer.md";
const SKILL = join("skills", "aidlc", "SKILL.md");
const MISSING_VERDICT_FINDING = "review did not complete within its turn budget";

/** The frontmatter block of an agent .md (throws when unclosed). */
function frontmatter(body: string, label: string): string {
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error(`${label}: no closed YAML frontmatter block`);
  return m[1];
}

/** The `## Turn Budget` section body (to the next `## ` heading or EOF). */
function turnBudgetSection(body: string, label: string): string {
  const m = body.match(/^## Turn Budget\r?\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m);
  if (!m) throw new Error(`${label}: no ## Turn Budget section`);
  return m[1];
}

describe("t279 reviewer turn budget is stated on every surface", () => {
  for (const agent of REVIEWERS) {
    test(`${agent}: core frontmatter carries maxTurns: ${CAP} and the Turn Budget section quotes the same number`, () => {
      const path = join(REPO_ROOT, "core", "agents", `${agent}.md`);
      const body = readFileSync(path, "utf-8");
      const fm = frontmatter(body, path);
      // Exactly one maxTurns key, value 60 (the frontmatter side of the pair).
      const keys = [...fm.matchAll(/^maxTurns:\s*(\d+)\s*$/gm)];
      expect(keys.length).toBe(1);
      expect(keys[0][1]).toBe(CAP);
      // The persona section exists and quotes the SAME number - the two live
      // in one file so a bump edits both or this pin reds.
      const section = turnBudgetSection(body, path);
      expect(section).toMatch(new RegExp(`hard cap of ${CAP} turns`, "i"));
      expect(section).toContain(`\`maxTurns: ${CAP}\``);
      expect(section).toMatch(/keep the two numbers in sync/);
      // Worst-case cutoff semantics, stated unconditionally: stopped, no
      // final-message turn, caller gets nothing, unwritten review lost.
      // (Wording is per-persona; both voicings must carry the facts.)
      expect(section).toMatch(/worst case/i);
      expect(section).toMatch(/with(out| no) warning/i);
      expect(section).toMatch(/final-message turn/);
      // Harness-neutral: the persona must NOT name harnesses or per-harness
      // cap keys - conditional enforcement prose would undermine the budget
      // exactly where no native cap exists.
      expect(section).not.toMatch(/Claude Code|opencode|Codex|Kiro|Cursor|Copilot/i);
      expect(section).not.toContain("steps:");
      // The final turns are reserved for writing the review file.
      expect(section).toMatch(/RESERVED/);
      expect(section).toContain("review file");
      // A thin verdict beats no verdict; never end without the review - and
      // the review must parse: exactly one, exactly one canonical verdict,
      // written to the file the dispatch named and nowhere else.
      expect(section).toMatch(/ALWAYS beats no verdict/);
      expect(section).toMatch(/exactly ONE review, to the review file the dispatch named/);
      expect(section).toMatch(/exactly one verdict line/);
      expect(section).toMatch(/Never write to the artifact you are reviewing/);
      expect(section).toMatch(
        /Never end your run with the review file for this iteration unwritten\./,
      );
      expect(section).not.toContain("## Review");
    });

    test(`${agent}: shipped Claude dist carries the binding maxTurns frontmatter and the Turn Budget prose`, () => {
      // The packager's projectTierFrontmatter rewrites ONLY the tier: line,
      // so maxTurns must ship verbatim - this is the enforcing surface on
      // Claude Code.
      const body = readFileSync(join(AIDLC_SRC, "agents", `${agent}.md`), "utf-8");
      const fm = frontmatter(body, `dist/claude ${agent}`);
      expect(fm).toMatch(new RegExp(`^maxTurns: ${CAP}$`, "m"));
      expect(fm).not.toMatch(/^tier:/m); // projection completeness (t216's contract)
      expect(body).toContain("## Turn Budget");
      expect(body).toMatch(new RegExp(`hard cap of ${CAP} turns`, "i"));
    });

    test(`${agent}: codex TOML rewrites the frontmatter citation (a TOML persona has no frontmatter to point at)`, () => {
      const toml = readFileSync(
        join(REPO_ROOT, "dist", "codex", ".codex", "agents", `${agent}.toml`),
        "utf-8",
      );
      expect(toml).toContain(`\`maxTurns: ${CAP}\``); // the number still ships as prose
      expect(toml).toContain("prose-only here");
      // The dangling pointer the rewrite exists to remove.
      expect(toml).not.toContain("frontmatter above");
    });

    test(`${agent}: cursor and copilot rosters carry the inert maxTurns key plus the Turn Budget prose`, () => {
      // Neither harness has a native cap key; both tolerate unknown
      // frontmatter (shipped precedent: display_name), so the authored key
      // passes through and the persona prose citation stays literally true.
      for (const rosterDir of [
        join(REPO_ROOT, "dist", "cursor", ".cursor", "agents"),
        join(REPO_ROOT, "dist", "copilot", ".github", "agents"),
      ]) {
        const body = readFileSync(join(rosterDir, `${agent}.md`), "utf-8");
        const fm = frontmatter(body, join(rosterDir, `${agent}.md`));
        expect(fm).toMatch(new RegExp(`^maxTurns: ${CAP}$`, "m"));
        expect(fm).not.toMatch(/^steps:/m);
        expect(body).toContain("## Turn Budget");
      }
    });
  }

  test(`opencode native roster translates the cap: reviewers carry steps: ${CAP}, nobody carries maxTurns, no other agent gains steps`, () => {
    // opencode's per-agent cap key is `steps` (native since 1.0.134; the
    // legacy `maxSteps` spelling is deprecated). The emit renames core's
    // maxTurns so the shipped .opencode/agents/ roster - the ONLY dir
    // opencode itself reads - is natively capped; a pass-through maxTurns
    // there would be inert.
    const rosterDir = join(REPO_ROOT, "dist", "opencode", ".opencode", "agents");
    const roster = readdirSync(rosterDir).filter((f) => f.endsWith("-agent.md"));
    expect(roster.length).toBe(14);
    for (const f of roster) {
      const body = readFileSync(join(rosterDir, f), "utf-8");
      const fm = frontmatter(body, `dist/opencode ${f}`);
      expect(fm, `${f}: no maxTurns leak into the native roster`).not.toMatch(/^maxTurns:/m);
      const isReviewer = REVIEWERS.some((agent) => f === `${agent}.md`);
      if (isReviewer) {
        const keys = [...fm.matchAll(/^steps:\s*(\d+)\s*$/gm)];
        expect(keys.length, `${f}: exactly one steps key`).toBe(1);
        expect(keys[0][1], `${f}: steps mirrors the authored maxTurns`).toBe(CAP);
        // opencode's cutoff grants a final text-only turn - the persona
        // prose (shipped in the same file) still carries the write-early
        // instruction, because that turn cannot write the review file. The
        // emit also renames the prose citation to the native key.
        expect(body).toContain("## Turn Budget");
        expect(body).toContain(`\`steps: ${CAP}\``);
        expect(body).not.toContain("`maxTurns:");
      } else {
        expect(fm, `${f}: only the reviewers are capped`).not.toMatch(/^steps:/m);
      }
    }
  });

  test("kiro agent JSONs never receive the cap key (kiro-cli fail-closes on unknown agent-JSON fields)", () => {
    const rosterDir = join(REPO_ROOT, "dist", "kiro", ".kiro", "agents");
    for (const f of readdirSync(rosterDir).filter((n) => n.endsWith(".json"))) {
      const body = readFileSync(join(rosterDir, f), "utf-8");
      expect(body, `dist/kiro ${f}`).not.toContain("maxTurns");
    }
  });

  test("reviewer module §12a step 1 records the request, hydrates prior findings, and names the review file the reviewer writes (core + dist/claude)", () => {
    // The stale-READY hole: a stage passes review READY; the human rejects at
    // the gate; the builder revises a produces[] artifact; the re-review is
    // itself cut off before writing. The request opens an empty review slot
    // for every dispatch, so nothing stale can stand in for the review; the
    // artifact itself is never written by the reviewer, so nothing is deleted
    // or renamed inside it either.
    for (const path of [
      join(REPO_ROOT, "core", REVIEWER_MODULE),
      join(AIDLC_SRC, REVIEWER_MODULE),
    ]) {
      const body = readFileSync(path, "utf-8");
      const labelled = `${path}\n${body}`;
      expect(labelled).toMatch(
        /Invoke reviewer sub-agent\.\*\* Before every dispatch, not only the first,\s+record the request/,
      );
      expect(labelled).toContain("Before every dispatch, not only the first");
      expect(labelled).toContain("returns `requestId` and `reviewFile`");
      expect(labelled).toContain("The request opens that slot");
      expect(labelled).toContain(
        "`directive.review_artifact` names the one required Markdown output",
      );
      expect(labelled).toContain("Nobody writes to it");
      const request = labelled.indexOf("record the request:");
      const hydrate = labelled.indexOf("aidlc-review-brief.ts context", request);
      const dispatch = labelled.indexOf("Then delegate to the reviewer agent", hydrate);
      expect(request).toBeGreaterThan(-1);
      expect(hydrate).toBeGreaterThan(request);
      expect(dispatch).toBeGreaterThan(hydrate);
      expect(labelled).toContain("durable human dispositions from the audit ledger");
      expect(labelled).toContain("as the one file the reviewer writes");
      // The reviewer's write contract: one file, nothing else.
      expect(labelled).toContain("Writes exactly ONE file: its review, at the passed `reviewFile` path");
      expect(labelled).toContain("Writes NOTHING else");
      // The Part 0 revision-path paragraph relies on request binding, not on
      // deleting anything from the artifact.
      expect(labelled).toContain("the new request binds");
      // Negative pins: the retired appendix mechanics must not come back.
      expect(labelled).not.toContain("DELETE the existing `## Review` section");
      expect(labelled).not.toContain("## Review (superseded)");
      expect(labelled).not.toContain("reviewChallenge");
      expect(labelled).not.toMatch(/suspends the review freeze/);
    }
  });

  test("reviewer module §12a step 3 records the review as a record, validates one canonical verdict, and routes incomplete attempts through --retry-pending to a terminal receipt (core + dist/claude)", () => {
    for (const path of [
      join(REPO_ROOT, "core", REVIEWER_MODULE),
      join(AIDLC_SRC, REVIEWER_MODULE),
    ]) {
      const body = readFileSync(path, "utf-8");
      const labelled = `${path}\n${body}`;
      // t221's ordering (read verdict AFTER deleting the dispatch record)
      // still holds around the record write.
      expect(labelled).toMatch(
        /Read verdict.*delete `<record>\/\.aidlc-reviewer-dispatch\.json`.*validates it/s,
      );
      expect(labelled).toContain(
        "writes the review record `<record>/.aidlc-reviews/<stage>/stage/<attempt>/<iteration>.json` (or the Unit path under `units/<unit>/`)",
      );
      expect(labelled).toContain("The record is the review; only this command writes one");
      // Partial and duplicated reviews are named incomplete, not guessed at.
      expect(labelled).toMatch(/no canonical verdict line/);
      expect(labelled).toContain(
        "rendered Markdown or raw-HTML H1/H2 headings are section escapes",
      );
      expect(labelled).toContain("validates it with Bun's Markdown parser");
      expect(labelled).toContain(
        "list/blockquote/table containers cannot mint ownership",
      );
      expect(labelled).toContain(
        "forged/missing/conflicting duplicate ownership fields",
      );
      // The incomplete-attempt path: retry the SAME unmatched request once,
      // consuming no iteration (the advisory budget is one pass - counting a
      // cut-off attempt would exhaust it without any review happening).
      expect(labelled).toContain("**On an incomplete attempt:**");
      expect(labelled).toMatch(/re-dispatch it exactly once/);
      expect(labelled).toMatch(/has not already\s+spent its retry/);
      expect(labelled).toMatch(
        /original artifact and source bytes are unchanged/,
      );
      expect(labelled).toMatch(/never mints a\s+new fingerprint/);
      expect(labelled).toContain("`Upgrade: legacy-request`");
      expect(labelled).toMatch(
        /A field-light historical\s+`Retry: pending-request` marker is not a modern binding/,
      );
      expect(labelled).toMatch(
        /A structurally malformed request row\s+has no authority and is ignored/,
      );
      // The second incomplete attempt records the terminal receipt with the
      // named finding and routes per review class.
      expect(labelled).toContain(MISSING_VERDICT_FINDING);
      expect(labelled).toMatch(
        /record the\s+terminal receipt with `--verdict NOT-READY` and no review file/,
      );
      expect(labelled).toMatch(/on `advisory` it is terminal/);
      expect(labelled).toMatch(/skip the lead re-invoke/);
      expect(labelled).toMatch(
        /never presented on a\s+silently missing verdict, and never deadlocks/,
      );
      // The turn cap is named as the reachable cause of a missing review.
      expect(labelled).toMatch(/hard turn cap/);
      // The complete-review receipt sentence survives verbatim - it was
      // silently dropped once in a rebase (PR #613 round 2, P1) and nothing
      // pinned it; now something does.
      expect(labelled).toMatch(
        /record the terminal receipt with the same `aidlc-log\.ts review` command plus `--verdict <READY\|NOT-READY>`/,
      );
      // Step 1's dispatch-failure contract names the incomplete attempt as a
      // retry-pending cause too.
      expect(labelled).toMatch(/or ends without a recorded verdict/);
      expect(labelled).toMatch(
        /reuses those\s+original fingerprints and request id instead of rebaselining/,
      );
      expect(labelled).toContain(
        "malformed audit `REVIEW_COMPLETED` row is ignored and does not consume the pending request",
      );
      expect(labelled).toContain("one coherent snapshot");
      // Migration: the embedded form is readable and deprecated, never written.
      expect(labelled).toContain("**Migration (deprecated).**");
      expect(labelled).toContain("removed in the next minor release");
    }
  });

  test("the reviewer-scope enforcement roster names all six enforcing harnesses, Copilot included", () => {
    // Copilot's adapter forwards PreToolUse calls to core's
    // aidlc-reviewer-scope.ts (harness/copilot/hooks/aidlc-copilot-adapter.ts),
    // so the protocol's dispatch-record roster must include it - it was
    // written before the Copilot harness landed and went stale.
    for (const path of [
      join(REPO_ROOT, "core", REVIEWER_MODULE),
      join(AIDLC_SRC, REVIEWER_MODULE),
    ]) {
      const body = readFileSync(path, "utf-8");
      expect(body).toContain(
        "(Claude Code, Kiro CLI, Codex CLI, opencode, Cursor, and GitHub Copilot today)",
      );
    }
  });

  test("all seven harness SKILL.md files load the reviewer module, and every shipped module copy carries the delete rule, the canonical-verdict validation, and the retry contract", () => {
    for (const harness of HARNESS_MATRIX) {
      // The SKILL reviewer bullet is now a module pointer: it must name the
      // module and keep the reviewer-field fallback trigger.
      for (const path of [
        join(harness.authoredRoot, SKILL),
        join(harness.skillsRoot, "aidlc", "SKILL.md"),
      ]) {
        const body = readFileSync(path, "utf-8");
        const labelled = `harness ${harness.name}: ${path}\n${body}`;
        expect(labelled).toContain("stage-protocol-reviewer.md");
        expect(labelled).toMatch(/when the engine lists `reviewer` in `directive\.protocol_modules`/);
        expect(labelled).toContain("when `directive.reviewer` is present");
      }
      // The guard prose the bullet used to carry inline now ships in the
      // harness's module copy.
      const module = readFileSync(
        join(harness.engineRoot, "aidlc-common", "protocols", "stage-protocol-reviewer.md"),
        "utf-8",
      );
      const labelled = `harness ${harness.name} module\n${module}`;
      // Request-first, hydrate dispositions, then dispatch with the review
      // file named, on every dispatch.
      expect(labelled).toContain("Before every dispatch, not only the first");
      expect(labelled).toContain("returns `requestId` and `reviewFile`");
      expect(labelled).toContain("aidlc-review-brief.ts context");
      expect(labelled).toContain(
        "durable human dispositions from the audit ledger",
      );
      expect(labelled).toContain("Writes exactly ONE file: its review, at the passed `reviewFile` path");
      expect(labelled).toContain("Writes NOTHING else");
      // The record write and canonical-verdict validation.
      expect(labelled).toContain("writes the review record `<record>/.aidlc-reviews/");
      expect(labelled).toContain("The record is the review; only this command writes one");
      expect(labelled).toMatch(/no canonical verdict line/);
      // Incomplete attempt: one retry, then the terminal NOT-READY receipt.
      expect(labelled).toContain(MISSING_VERDICT_FINDING);
      expect(labelled).toMatch(/no review file at all/);
      expect(labelled).toContain("`--retry-pending`");
      expect(labelled).toMatch(/re-dispatch it\s+exactly once/);
      expect(labelled).toMatch(/never mints a\s+new fingerprint/);
      expect(labelled).toContain("`Upgrade: legacy-request`");
      expect(labelled).toMatch(
        /A structurally malformed request row\s+has no authority and is ignored/,
      );
      // The retired appendix mechanics stay retired on every harness.
      expect(labelled).not.toContain("DELETE the existing `## Review` section");
      expect(labelled).not.toContain("reviewChallenge");
      expect(labelled).not.toMatch(/suspends the review freeze/);
      // The review-class contract is present on every harness - including
      // Copilot, which shipped without it (its bullet predated #718 and the
      // six-harness test lists never caught it).
      expect(labelled).toContain("`review_class`");
      expect(labelled).toContain("on `advisory` it is terminal");
      // Negative pin: the rename mechanism must not come back.
      expect(labelled).not.toContain("## Review (superseded)");
    }
  });

  test("kiro-ide SKILL stays free of any dispatch-record mention (t221's pin, re-asserted beside the module pointer)", () => {
    const body = readFileSync(join(REPO_ROOT, "harness", "kiro-ide", SKILL), "utf-8");
    expect(body).toContain("stage-protocol-reviewer.md");
    expect(body).not.toContain(".aidlc-reviewer-dispatch.json");
    // The shared module keeps the guard prose and grants kiro-ide its
    // no-dispatch-record carve-out explicitly.
    const module = readFileSync(
      join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "aidlc-common", "protocols", "stage-protocol-reviewer.md"),
      "utf-8",
    );
    expect(module).toContain(MISSING_VERDICT_FINDING);
    expect(module).toContain("(Kiro IDE today), do not write the record");
  });
});
