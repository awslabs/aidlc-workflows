// covers: file:core/memory/org.md function:augmentDispatchRules
//
// t266-conversation-language — the CONVERSATION-LANGUAGE rule layer
// (deterministic, no-LLM, no-network). Pins the four `## Mandated` rules in
// `org.md` that make human-readable artifacts follow the conversation language
// instead of defaulting to English (#288).
//
// The rules are prose, so what CAN be pinned deterministically is the machinery
// around them: that they ship to every harness, that they stay quotable by the
// claim-sources sensor, that a delegated agent actually receives them, and that
// the English exception never regresses back to whole-file scope. Those are the
// three regression areas the review asked for — language continuity, delegated
// execution, and preservation of machine tokens.
//
// Four contracts land here:
//   (a) SHIP PARITY: all four rules live under `## Mandated` in the authored
//       `core/memory/org.md` AND byte-identically in both org.md projections of
//       every shipped harness (the engine-bundled `tools/data/memory-seed/` seed
//       and the `aidlc/spaces/default/memory/` workspace shell). A harness that
//       silently drops the rule layer would leave its users on English output.
//   (b) LINE-LEVEL QUOTABILITY: each rule is ONE physical line. The
//       claim-sources sensor resolves a `[memory:M<n>]` source by stripping the
//       bullet marker from each line under the named H2 and requiring the quoted
//       rule to match an entry EXACTLY. A rule wrapped across lines can never be
//       registered as a source, so a stage that reasons from it would fail its
//       own sensor. This is the constraint that forces the one-line-per-rule
//       shape — it is easy to "improve" readability and break it.
//   (c) DELEGATED EXECUTION: a subagent never sees the conversation, so the
//       rules must arrive in its brief. The dispatch-rules PreToolUse hook is
//       that carrier; augmentDispatchRules must rewrite a delegated prompt to
//       carry all four rules verbatim.
//   (d) TOKEN SCOPE: the preserved-token rule names the real protocol tokens,
//       and the rule set does NOT reintroduce a blanket whole-file English
//       exception (the pre-review shape said "any other tool-read file", which
//       wrongly Englished Markdown artifacts that only mix in parsed islands).
//
// MECHANISM. (a)/(b)/(d) read the shipped files directly (the `none` floor).
// (c) SPAWNS the real engine CLI to birth an intent into a temp project, then
// calls the shipped hook's exported pure entry in-process. Zero tokens, zero
// network.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import { augmentDispatchRules } from "../../dist/claude/.claude/hooks/aidlc-deliver-stage-rules.ts";

const BUN = process.execPath;
const UTILITY = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const AUTHORED_ORG_MD = join(REPO_ROOT, "core", "memory", "org.md");

/** The four rules' stable lead-ins. Deliberately the bold label only: the bodies
 *  are prose a maintainer may reword, but a MISSING or RENAMED rule is a
 *  regression these tests must catch. */
const RULE_LABELS = [
  "**Conversation language — resolution**",
  "**Conversation language — stability**",
  "**Conversation language — what to localize**",
  "**Conversation language — preserved tokens**",
] as const;

/** Protocol tokens the preserved-token rule must keep naming. Each one is a real
 *  parsed island or exact-compared literal in the shipped engine — dropping it
 *  from the rule invites an agent to localize something a tool matches verbatim.
 *  All of these were found by grepping the shipped engine during an end-to-end
 *  Japanese run, and several are exact `===`/`!==` comparisons rather than
 *  advisory shapes:
 *    - `A. Accept assumptions` — aidlc-sensor-claim-sources.ts compares the
 *      filled `[Answer]:` against this literal to set assumptionsAccepted.
 *    - `**Collaborator:** <agent-slug>` — compared with `!==` against a
 *      contribution file's first line in aidlc-orchestrate.ts, aidlc-state.ts,
 *      and aidlc-doctor-bundle.ts; a localized marker fails the stage outright.
 *    - `None.` / `None` — sentinels the conductor branches on under
 *      `## Assumptions & Open Questions` and `## Positions`.
 *    - `X. Other (please specify)` — the mandatory final option of every
 *      question (stage-protocol §3, "no exceptions").
 *  The rule also states the GENERAL principle (a backticked literal a stage
 *  file tells you to write exactly is a fixed token), so this list pins the
 *  high-risk instances rather than trying to be exhaustive. */
const REQUIRED_TOKENS = [
  "[Answer]:",
  "X. Other (please specify)",
  "A. Accept assumptions",
  "B. Convert to follow-up questions",
  "`None.` / `None`",
  "AGREE:",
  "OBJECT:",
  "**Collaborator:** <agent-slug>",
  "[desc]",
  "[scope]",
  "[assumption]",
  "[Q<n>]",
  "[memory:M<n>]",
  // The two literal prefixes the claim-sources sensor matches on their own,
  // alongside the bracket tags — a register line loses its source when either
  // is localized, so the rule has to name them as tokens too.
  "Initial description:",
  "Workflow-selected scope:",
  "required-sections",
  "## Sources",
  "## Assumptions & Open Questions",
  "## Assumption Confirmation",
  "## Review",
  "READY",
  "NOT-READY",
  "depends_on",
  "aidlc-state.md",
] as const;

/** The no-signal turn shapes the review named. A turn that is only one of these
 *  must never flip the conversation language — this is review requirement 1's
 *  concrete test. */
const NO_SIGNAL_TURNS = [
  "`Approve`",
  "`Looks correct`",
  "an option letter or number",
  "pasted code",
  "a quoted error or stack trace",
  "a bare file path or identifier",
] as const;

/** The over-broad phrasings the review rejected. Any of these coming back means
 *  the English exception has widened from "parsed syntax" to "whole file". */
const FORBIDDEN_BLANKETS = [
  "any other tool-read file",
  "machine-parsed state files",
  "Machine-facing files stay fully English",
] as const;

/** A `## Mandated` entry that legislates artifact language. Matched on the bold
 *  label so RULE_LABELS is the only sanctioned shape: the four rules are ONE
 *  coherent contract read by a model, so a fifth entry that also rules on
 *  language is a contradiction the model has to resolve on its own, not an
 *  addition. Presence tests alone cannot catch that — appending
 *  "ALWAYS write every artifact in English" leaves all four rules intact. */
const LANGUAGE_RULE_LABEL = /^\*\*(?:Conversation language|Language)\b[^*]*\*\*/;

/** Prose that would countermand the rules while leaving their labels in place.
 *  Not an exhaustive filter — a determined edit can always evade a string list.
 *  The real guard is the entry-count contract above; these catch the shapes a
 *  plausible "clarification" would take. */
const CONTRADICTIONS = [
  /\bALWAYS\s+write\s+(?:\w+\s+){0,3}(?:in\s+)?English\b/i,
  /\brules?\s+above\s+(?:are|is)\s+advisory\b/i,
  /\bregardless\s+of\s+the\s+conversation\s+language\b/i,
  /\bdefault\s+to\s+English\b/i,
] as const;

/** Visible lines under an H2, reduced the way aidlc-sensor-claim-sources.ts
 *  reduces them when resolving a `[memory:M<n>]` source: bullet marker stripped,
 *  trimmed, blanks and blockquotes dropped. Mirroring the sensor here is the
 *  point — it is what makes (b) a real contract and not a formatting opinion. */
function sectionEntries(body: string, heading: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end))
    .map((line) => line.replace(/^ {0,3}(?:[-*+]|\d+\.)\s+/, "").trim())
    .filter((line) => line.length > 0 && !/^>/.test(line) && !/^<!--/.test(line));
}

/** Both org.md projections of a shipped harness: the engine-bundled seed used by
 *  the engine-only-install self-heal, and the workspace shell users copy. */
function orgMdProjections(): Array<{ label: string; path: string }> {
  const out: Array<{ label: string; path: string }> = [];
  for (const harness of HARNESS_MATRIX) {
    out.push({
      label: `${harness.name} memory-seed`,
      path: join(harness.engineRoot, "tools", "data", "memory-seed", "org.md"),
    });
    out.push({
      label: `${harness.name} workspace shell`,
      path: join(harness.distRoot, "aidlc", "spaces", "default", "memory", "org.md"),
    });
  }
  return out;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("t266 conversation-language rule layer", () => {
  // === (a) SHIP PARITY =====================================================
  test("a: all four rules sit under ## Mandated in the authored source", () => {
    const entries = sectionEntries(readFileSync(AUTHORED_ORG_MD, "utf-8"), "Mandated");
    for (const label of RULE_LABELS) {
      expect(
        entries.some((entry) => entry.startsWith(label)),
        `${label} is a ## Mandated entry in core/memory/org.md`,
      ).toBe(true);
    }
  });

  test("a: every shipped harness carries the authored org.md byte-for-byte", () => {
    const authored = readFileSync(AUTHORED_ORG_MD, "utf-8");
    const projections = orgMdProjections();
    // Guards against a harness manifest that stops projecting the method tree:
    // five shipped harnesses x two projections.
    expect(projections.length).toBe(HARNESS_MATRIX.length * 2);
    for (const { label, path } of projections) {
      expect(readFileSync(path, "utf-8"), `${label} matches core/memory/org.md`).toBe(authored);
    }
  });

  // === (b) LINE-LEVEL QUOTABILITY ==========================================
  test("b: each rule is one physical line, so the claim-sources sensor can quote it", () => {
    const body = readFileSync(AUTHORED_ORG_MD, "utf-8").replace(/\r\n/g, "\n");
    const lines = body.split("\n");
    const entries = sectionEntries(body, "Mandated");
    for (const label of RULE_LABELS) {
      const matches = entries.filter((entry) => entry.startsWith(label));
      // Exactly one entry per rule: a wrapped rule would surface as a leading
      // entry plus orphan continuation entries, and the sensor's exact-match
      // lookup would never resolve the full sentence.
      expect(matches.length, `${label} resolves to exactly one sensor entry`).toBe(1);

      const at = lines.findIndex((line) => line.includes(label));
      expect(at, `${label} appears on exactly one raw line`).toBeGreaterThan(-1);
      expect(lines.filter((line) => line.includes(label)).length).toBe(1);
      // The raw line IS the whole entry (no leading indent, bullet at column 0).
      expect(lines[at]).toBe(`- ${matches[0]}`);
      // And nothing continues it. A soft-wrapped rule leaves an INDENTED prose
      // line beneath the bullet; Markdown folds that into the same list item,
      // but the sensor reduces line-by-line and would only ever see the first
      // line — so the quoted source could never match. The next line must
      // therefore be blank, a new top-level bullet, or the next heading.
      const next = lines[at + 1] ?? "";
      expect(
        next.trim() === "" || /^(?:- |## )/.test(next),
        `${label} is not soft-wrapped (continuation line found: ${JSON.stringify(next)})`,
      ).toBe(true);
      // A complete rule reads as a finished sentence.
      expect(matches[0].endsWith("."), `${label} ends as a complete sentence`).toBe(true);
    }
  });

  // === (c) DELEGATED EXECUTION =============================================
  test("c: a delegated dispatch is rewritten to carry all four rules", () => {
    const proj = mkdtempSync(join(tmpdir(), "aidlc-t266-"));
    tempDirs.push(proj);
    const birth = spawnSync(
      BUN,
      [UTILITY, "intent-create", "--scope", "poc", "--arguments", "x", "--project-dir", proj],
      { encoding: "utf-8" },
    );
    expect(birth.status, `intent-create failed: ${birth.stdout}\n${birth.stderr}`).toBe(0);

    const result = augmentDispatchRules(
      "task",
      {
        subagent_type: "aidlc-product-agent",
        prompt: "Execute the current stage and write its artifacts.",
      },
      proj,
    );
    expect(result.error ?? null, "dispatch rewrite produced no error").toBeNull();
    expect(result.changed, "the hook rewrote the delegated prompt").toBe(true);

    const prompt = String(result.updatedInput?.prompt ?? "");
    for (const label of RULE_LABELS) {
      // A subagent cannot see the conversation; the bundle is how it learns the
      // language contract at all.
      expect(prompt.includes(label), `${label} reached the delegated brief`).toBe(true);
    }
  });

  // === (c2) HARNESS DELIVERY ===============================================
  // (c) proves the hook rewrite path, but only through the CLAUDE copy of the
  // hook. Claude, Codex, and opencode all use that path; Kiro CLI has no
  // input-rewrite channel and Kiro IDE cannot expose tool arguments at all, so
  // both rely on PRELOAD instead. Two ways this could silently regress while
  // (c) stays green: a harness ships a stale or diverged hook, or a Kiro
  // manifest stops projecting the memory glob. Check the delivered artifact
  // itself in both cases rather than its mere presence.
  test("c2: every harness ships a surface that delivers active memory to delegated agents", () => {
    // The glob Kiro agent configs must preload. Exact string, not a substring:
    // `r.includes("memory")` would accept `file://docs/memory-notes.md` and any
    // other path that merely has the word in it.
    const MEMORY_GLOB = "file://aidlc/spaces/default/memory/**/*.md";
    const authoredHook = readFileSync(
      join(REPO_ROOT, "core", "hooks", "aidlc-deliver-stage-rules.ts"),
      "utf-8",
    );

    for (const harness of HARNESS_MATRIX) {
      const hook = join(harness.engineRoot, "hooks", "aidlc-deliver-stage-rules.ts");
      expect(existsSync(hook), `${harness.name} ships the dispatch-rules hook`).toBe(true);
      // Byte parity with the authored hook is what carries (c)'s proof across
      // harnesses: the rewrite exercised there is literally this code.
      expect(
        readFileSync(hook, "utf-8"),
        `${harness.name}'s hook matches core/hooks/aidlc-deliver-stage-rules.ts, so (c) covers it`,
      ).toBe(authoredHook);

      if (!harness.capabilities.kiroAgentJson) continue;
      // Kiro's preload path: EVERY agent config must name the active-space
      // memory glob, or that agent starts a stage without the rule layer.
      const agentsDir = join(harness.engineRoot, "agents");
      const configs = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
      expect(configs.length, `${harness.name} ships agent configs`).toBeGreaterThan(0);
      for (const file of configs) {
        const raw: unknown = JSON.parse(readFileSync(join(agentsDir, file), "utf-8"));
        const resources = (raw as { resources?: unknown }).resources;
        const list = Array.isArray(resources) ? resources.filter((r): r is string => typeof r === "string") : [];
        expect(
          list,
          `${harness.name}/${file} preloads the active-space memory tree`,
        ).toContain(MEMORY_GLOB);
      }
      // A glob is only a promise; resolve it against the shipped workspace shell
      // and confirm it actually reaches the org.md that carries the rules.
      const globbed = MEMORY_GLOB.replace(/^file:\/\//, "").replace("**/*.md", "org.md");
      const preloaded = join(harness.distRoot, globbed);
      expect(
        existsSync(preloaded),
        `${harness.name}'s memory glob resolves to a real org.md (${globbed})`,
      ).toBe(true);
      const preloadedBody = readFileSync(preloaded, "utf-8");
      for (const label of RULE_LABELS) {
        expect(
          preloadedBody.includes(label),
          `${harness.name}'s preloaded org.md carries ${label}`,
        ).toBe(true);
      }
    }
  });

  // (c2) covers the DELEGATE side. It does not cover the CONDUCTOR, and on Kiro
  // IDE it does not even cover the right file: the agent-v1 JSONs it inspects
  // are a Kiro CLI compatibility surface the IDE ignores (harness/kiro-ide/
  // manifest.ts says so in prose), while the IDE's actual binding surface is the
  // always-included steering file. This test walks `memoryInclude` instead — the
  // per-harness seam aidlc-includes.ts re-points on a space switch — and proves
  // each one reaches the org.md that ships the rules IN THAT HARNESS'S OWN
  // SYNTAX. It matters for the conductor specifically because the rules oblige
  // the ORCHESTRATOR to restate `Conversation language:` on every dispatch: an
  // obligation it never sees is an obligation it cannot honour.
  test("c3: every harness's conductor-facing memory include reaches the rules", () => {
    const MEMORY_DIR = "aidlc/spaces/default/memory";
    const seen = new Set<string>();

    for (const harness of HARNESS_MATRIX) {
      const include = harness.capabilities.memoryInclude;
      seen.add(include);
      const shippedOrgMd = join(harness.distRoot, MEMORY_DIR, "org.md");
      expect(
        existsSync(shippedOrgMd),
        `${harness.name} ships the workspace-shell org.md the include must reach`,
      ).toBe(true);

      // Each arm names the surface, then the exact reference it must carry.
      // Substring-on-"memory" is deliberately avoided: `docs/memory-notes.md`
      // would satisfy it while binding nothing.
      let surface: string;
      let required: string;
      switch (include) {
        case "claude-import":
          // Claude @-imports resolve relative to the importing file; from
          // .claude/rules/ the workspace root is ../../.
          surface = join(harness.engineRoot, "rules", "aidlc.md");
          required = `@../../${MEMORY_DIR}/org.md`;
          break;
        case "codex-env":
          surface = join(harness.engineRoot, "config.toml");
          required = `AIDLC_RULES_DIR = "${MEMORY_DIR}"`;
          break;
        case "kiro-steering":
          // The IDE's real surface: an always-included steering file whose
          // #[[file:...]] references pull the live memory tree in verbatim.
          surface = join(harness.engineRoot, "steering", "aidlc-active-memory.md");
          required = `#[[file:${MEMORY_DIR}/org.md]]`;
          break;
        case "kiro-resources":
          // Kiro CLI: the conductor is itself an agent config, so its own
          // resources list is the include. Named explicitly, not any config.
          surface = join(harness.engineRoot, "agents", "aidlc.json");
          required = `file://${MEMORY_DIR}/**/*.md`;
          break;
        case "opencode-instructions":
          surface = join(harness.distRoot, "opencode.json");
          required = `${MEMORY_DIR}/**/*.md`;
          break;
        default:
          throw new Error(
            `${harness.name} declares memoryInclude "${include}" with no assertion here — ` +
              "add an arm so a new harness cannot ship an unproven conductor include",
          );
      }

      expect(existsSync(surface), `${harness.name} ships its ${include} surface`).toBe(true);
      const body = readFileSync(surface, "utf-8");
      expect(
        body.includes(required),
        `${harness.name}'s ${include} surface must carry ${required}`,
      ).toBe(true);

      // An always-included file is only always-included if it says so.
      if (include === "kiro-steering") {
        expect(
          /^---\n(?:.*\n)*?inclusion:\s*always\n(?:.*\n)*?---/.test(body),
          `${harness.name}'s steering file declares inclusion: always`,
        ).toBe(true);
      }

      // The reference is a promise; the file it points at must carry the rules.
      const orgMdBody = readFileSync(shippedOrgMd, "utf-8");
      for (const label of RULE_LABELS) {
        expect(
          orgMdBody.includes(label),
          `${harness.name}'s ${include} target org.md carries ${label}`,
        ).toBe(true);
      }
    }

    // Every declared include kind was exercised, so the switch above cannot
    // quietly stop covering a harness that changes its seam.
    expect(seen.size, "every memoryInclude kind in the matrix was asserted").toBe(
      new Set(HARNESS_MATRIX.map((h) => h.capabilities.memoryInclude)).size,
    );
  });

  // === (d) TOKEN SCOPE =====================================================
  test("d: the stability rule names every no-signal turn shape (language continuity)", () => {
    // The review's first requirement: a turn that is only `Approve`, an option
    // number, pasted code, or an English error must NOT flip the language. The
    // rule can only hold the line if it enumerates those shapes, so pin them.
    const entries = sectionEntries(readFileSync(AUTHORED_ORG_MD, "utf-8"), "Mandated");
    const rule = entries.find((entry) =>
      entry.startsWith("**Conversation language — stability**"),
    );
    expect(rule, "the stability rule exists").toBeDefined();
    for (const shape of NO_SIGNAL_TURNS) {
      expect(rule?.includes(shape), `stability rule names the no-signal turn "${shape}"`).toBe(true);
    }
    // And it must keep the two-step distinction that makes a switch usable:
    // the change is live at once; persistence is durability, not activation.
    expect(rule?.includes("IMMEDIATELY"), "stability rule makes a switch take effect at once").toBe(true);
    expect(
      rule?.includes("never the activation step"),
      "stability rule separates persistence from activation",
    ).toBe(true);
  });

  // The guarantee's scope. "Holds for the whole WORKFLOW" was not true of the
  // implementation: an explicitly switched language the human declines to
  // persist is carried only by the `Conversation language:` line, which lives in
  // the conversation. A workflow outlives a session — it can be parked and
  // resumed — and `aidlc-session-start.ts` injects scope, phase, stage, status,
  // agent and next action but NO language, so the first turn of a resumed
  // session has no language signal at all. Left unscoped, the rule promised
  // continuity the engine cannot deliver and a resumed conductor could silently
  // fall back to the English initial description. Scope the promise to the
  // session and make the fresh-session path explicit and TOTAL, so no branch
  // ends in "assume English".
  test("d: the stability guarantee is session-scoped with a total fresh-session fallback", () => {
    const entries = sectionEntries(readFileSync(AUTHORED_ORG_MD, "utf-8"), "Mandated");
    const rule = entries.find((entry) =>
      entry.startsWith("**Conversation language — stability**"),
    );
    expect(rule, "the stability rule exists").toBeDefined();

    // The promise itself, and that it still covers everything INSIDE a session
    // (scoping it must not weaken the no-signal-turn guarantee to one turn).
    expect(
      rule!.includes("holds for the whole session"),
      "the guarantee is scoped to the session, which is what the brief line can carry",
    ).toBe(true);
    expect(
      /inside that session for every stage, dispatch, reviewer pass and approval gate of the workflow/.test(
        rule as string,
      ),
      "within a session the language still holds across every stage, dispatch and gate",
    ).toBe(true);
    expect(
      rule!.includes("nothing but a session boundary ends it"),
      "only a session boundary ends the established language",
    ).toBe(true);

    // The gap is named concretely, so a future reader can check the claim
    // against the hook instead of trusting the prose.
    expect(
      /resume context the engine injects at session start carries [^.]*but NO language/.test(
        rule as string,
      ),
      "the rule states that the resume context injects no language",
    ).toBe(true);
    // The obligation is the orchestrator's, and it lands BEFORE any dispatch —
    // otherwise the first brief of a resumed session is the thing that guesses.
    expect(
      /orchestrator MUST re-resolve the language before it dispatches anything/.test(
        rule as string,
      ),
      "a fresh session re-resolves before the first dispatch",
    ).toBe(true);
    // Total: every branch terminates, and none of them terminates in English.
    for (const step of [
      "the persisted rule from (2)",
      "the human-readable artifacts this workflow has already produced",
      "the verbatim initial description from (3)",
      "ASKS the human rather than defaulting to English",
    ]) {
      expect(rule!.includes(step), `the fresh-session fallback names: ${step}`).toBe(true);
    }
    // Re-resolution must not be mistaken for a switch: treating it as one would
    // send it down the §13 write path and persist a language the human never
    // asked for.
    expect(
      rule!.includes("Re-resolving is not a switch"),
      "re-resolution is distinguished from an explicit switch",
    ).toBe(true);
    // And the consequence is stated, so declining persistence is an informed
    // choice rather than a silent trap.
    expect(
      rule!.includes("An unpersisted switch therefore does not outlive its session"),
      "the cost of declining persistence is stated",
    ).toBe(true);

    // The superseded promise must not come back in ANY projection.
    for (const { label, text } of [
      { label: "core/memory/org.md", text: readFileSync(AUTHORED_ORG_MD, "utf-8") },
      ...orgMdProjections().map(({ label, path }) => ({
        label,
        text: readFileSync(path, "utf-8"),
      })),
    ]) {
      expect(
        text.includes("holds for the whole workflow"),
        `${label} must not promise continuity across a session boundary`,
      ).toBe(false);
    }
  });

  // Cross-file precedence. The fallback used to read "project.md OR team.md",
  // with its LAST-one-wins tie-break defined only for duplicates within "that
  // file". Both files can legitimately carry one: the §13 ritual permits project
  // or team scope (stage-protocol §13), so a newer TEAM-level rule could sit
  // opposite a stale PROJECT-level one with no defined winner. Position cannot
  // settle it either — aidlc-graph.ts concatenates org → team → project → phase
  // unconditionally, so team ALWAYS precedes project in the bundle regardless of
  // which was written last, and "the last one wins" would hand it to the stale
  // project rule. Two things fix it: persistence is project-only, and project
  // outranks team by rule rather than by position.
  test("d: language-switch persistence is project-only and outranks a team default", () => {
    const entries = sectionEntries(readFileSync(AUTHORED_ORG_MD, "utf-8"), "Mandated");
    const resolution = entries.find((entry) =>
      entry.startsWith("**Conversation language — resolution**"),
    );
    const stability = entries.find((entry) =>
      entry.startsWith("**Conversation language — stability**"),
    );
    expect(resolution, "the resolution rule exists").toBeDefined();
    expect(stability, "the stability rule exists").toBeDefined();

    expect(
      resolution!.includes("the ONLY file a language switch is ever persisted to"),
      "the fallback names project.md as the single persistence target",
    ).toBe(true);
    expect(
      resolution!.includes("ALWAYS outranks a conversation-language rule in `team.md`"),
      "project-level explicitly outranks a team-level language rule",
    ).toBe(true);
    expect(
      resolution!.includes("can only ever be a team default and NEVER the record of a switch"),
      "a team-level language rule is a default, never a switch record",
    ).toBe(true);
    // The reason the precedence has to be STATED rather than positional, named
    // with the concatenation order it defends against.
    expect(
      resolution!.includes("cross-file position is NOT recency"),
      "the rule warns that bundle position is not recency across files",
    ).toBe(true);
    expect(
      resolution!.includes("`org → team → project → phase`"),
      "the runtime concatenation order is named, so the claim is checkable",
    ).toBe(true);
    // The within-file tie-break survives, but is now explicitly bounded to
    // project.md rather than to whichever file happened to be read.
    expect(
      resolution!.includes("within `project.md`, when it carries more than one"),
      "the LAST-one-wins tie-break is scoped to project.md",
    ).toBe(true);
    // The write side must agree with the read side, or the ritual could still
    // create the ambiguity the precedence exists to resolve.
    expect(
      stability!.includes("in `project.md` and NEVER in `team.md`"),
      "the ritual persists a switch to project.md only",
    ).toBe(true);

    // The superseded, ambiguous shape must be gone from every projection.
    for (const { label, text } of [
      { label: "core/memory/org.md", text: readFileSync(AUTHORED_ORG_MD, "utf-8") },
      ...orgMdProjections().map(({ label, path }) => ({
        label,
        text: readFileSync(path, "utf-8"),
      })),
    ]) {
      expect(
        text.includes("`project.md` or `team.md` — the FALLBACK"),
        `${label} must not leave the persisted fallback split across two files`,
      ).toBe(false);
    }
  });

  test("d: the resolution rule gives a delegated agent a source that always exists", () => {
    // Sources that read files can all come up empty: a greenfield run of a
    // stage whose `consumes` are every one `conditional_on: brownfield`
    // (practices-discovery) reaches its dispatched LEAD with no upstream
    // artifact and no draft. The orchestrator-stated brief line is the only
    // source that cannot be empty, so the rule must mandate it.
    const entries = sectionEntries(readFileSync(AUTHORED_ORG_MD, "utf-8"), "Mandated");
    const rule = entries.find((entry) =>
      entry.startsWith("**Conversation language — resolution**"),
    );
    expect(rule, "the resolution rule exists").toBeDefined();
    expect(
      rule?.includes("MUST state it as a `Conversation language: <language>` line in every delegated brief"),
      "resolution rule obliges the orchestrator to state the language in every brief",
    ).toBe(true);
    // Reviewers judge a `produces[]` artifact and spokes are dispatched against
    // a lead DRAFT; naming only `consumes[]` would exclude both.
    for (const handed of [
      "`consumes[]` contracts",
      "the artifact you were dispatched to review",
      "the lead draft you were dispatched against",
    ]) {
      expect(rule?.includes(handed), `resolution rule covers ${handed}`).toBe(true);
    }
  });

  test("d: the preserved-token rule names every protocol token it must protect", () => {
    const entries = sectionEntries(readFileSync(AUTHORED_ORG_MD, "utf-8"), "Mandated");
    const rule = entries.find((entry) =>
      entry.startsWith("**Conversation language — preserved tokens**"),
    );
    expect(rule, "the preserved-tokens rule exists").toBeDefined();
    for (const token of REQUIRED_TOKENS) {
      expect(rule?.includes(token), `preserved-tokens rule names ${token}`).toBe(true);
    }
  });

  test("d: the English exception never widens back to whole files", () => {
    // Checked across every projection, not just the authored source: a stale
    // dist would ship the rejected shape to users.
    const bodies = [
      { label: "core/memory/org.md", text: readFileSync(AUTHORED_ORG_MD, "utf-8") },
      ...orgMdProjections().map(({ label, path }) => ({
        label,
        text: readFileSync(path, "utf-8"),
      })),
    ];
    for (const { label, text } of bodies) {
      for (const blanket of FORBIDDEN_BLANKETS) {
        expect(
          text.includes(blanket),
          `${label} must not reintroduce the whole-file English exception "${blanket}"`,
        ).toBe(false);
      }
    }
  });

  test("d: no fifth rule can countermand the four (negative space)", () => {
    // The presence tests above are satisfied by all four labels being there,
    // which a contradicting FIFTH entry leaves untouched: appending
    // "**Language policy override**: ... ALWAYS write every artifact in English;
    // the conversation-language rules above are advisory only." keeps every
    // other assertion in this file green while inverting the whole feature.
    // These rules are prose read by a model, so a contradiction on disk is not
    // an additive rule — it is an unresolvable instruction. Pin the closed set.
    for (const { label, text } of [
      { label: "core/memory/org.md", text: readFileSync(AUTHORED_ORG_MD, "utf-8") },
      ...orgMdProjections().map(({ label, path }) => ({
        label,
        text: readFileSync(path, "utf-8"),
      })),
    ]) {
      const entries = sectionEntries(text, "Mandated");
      const languageRules = entries.filter((entry) => LANGUAGE_RULE_LABEL.test(entry));
      expect(
        languageRules.length,
        `${label} carries exactly the four conversation-language rules under ## Mandated (found ${languageRules.length}: ${languageRules
          .map((entry) => entry.slice(0, entry.indexOf("**", 2) + 2))
          .join(", ")})`,
      ).toBe(RULE_LABELS.length);
      // Every one of them must be a KNOWN rule, so a rename cannot smuggle a
      // fifth in while keeping the count at four.
      for (const rule of languageRules) {
        expect(
          RULE_LABELS.some((known) => rule.startsWith(known)),
          `${label}: unrecognized conversation-language rule ${JSON.stringify(rule.slice(0, 80))}`,
        ).toBe(true);
      }
      // And no entry anywhere under `## Mandated` may countermand them.
      for (const entry of entries) {
        for (const pattern of CONTRADICTIONS) {
          expect(
            pattern.test(entry),
            `${label}: ## Mandated entry countermands the conversation-language rules (${pattern}): ${JSON.stringify(entry.slice(0, 120))}`,
          ).toBe(false);
        }
      }
    }
  });

  // === (e) SWITCH PRECEDENCE ================================================
  // The second-pass review found the ordering contradiction these two tests
  // pin. The resolution rule used to rank a persisted `project.md`/`team.md`
  // language rule ABOVE the brief line, while the stability rule promised an
  // explicit switch takes effect immediately and persists only later at the
  // human-gated learnings ritual. A persisted-Japanese workflow that switched
  // to English therefore sent `Conversation language: English` in the brief and
  // the delegate stopped at the stale memory rule first.
  //
  // The fix inverts the two: the brief is authoritative for delegated work
  // because the orchestrator regenerates it from the live conversation on every
  // dispatch, so it can never be staler than a file on disk. Memory is the
  // fallback for a brief that states no language.
  test("e: the brief outranks persisted memory in the resolution order", () => {
    const entries = sectionEntries(readFileSync(AUTHORED_ORG_MD, "utf-8"), "Mandated");
    const rule = entries.find((entry) =>
      entry.startsWith("**Conversation language — resolution**"),
    );
    expect(rule, "the resolution rule exists").toBeDefined();

    const briefFirst = rule!.indexOf("(1) the `Conversation language:` line in your brief");
    const memorySecond = rule!.indexOf("(2) an explicit conversation-language rule");
    expect(briefFirst, "the brief line is ranked (1)").toBeGreaterThan(-1);
    expect(memorySecond, "the persisted memory rule is ranked (2)").toBeGreaterThan(-1);
    expect(briefFirst, "the brief is resolved BEFORE persisted memory").toBeLessThan(
      memorySecond,
    );
    // Naming the roles is what makes the ordering survive a reword.
    expect(rule!.includes("AUTHORITATIVE for delegated work")).toBe(true);
    expect(rule!.includes("the FALLBACK for a brief that states no language")).toBe(true);

    // The learnings write path APPENDS and never replaces: aidlc-learnings.ts
    // routes every selected learning through `appendUnderHeading`, which only
    // inserts — the dedupe upstream of it is `content.includes(marker)` against
    // the per-(stage, candidate_id) cid marker, NOT against the rule text. So a
    // second language rule proposed by a different stage or candidate appends
    // even when it contradicts the first, and `replaceSection` (which the
    // practices-discovery affirmation does use to overwrite rather than
    // accumulate) is deliberately not on this path. org.md's `## Corrections`
    // also ships empty, so the ritual's admission conflict-check has nothing to
    // compare a new language rule against. Both language rules can therefore
    // sit on disk at once, which leaves the fallback ambiguous unless the rule
    // breaks the tie.
    expect(
      rule!.includes("the LAST one under `## Corrections` is the current one"),
      "the fallback breaks the append-only tie deterministically",
    ).toBe(true);
    expect(
      rule!.includes("governs conversation-language rules ONLY"),
      "the tie-break is scoped and does not override the additive rule model",
    ).toBe(true);

    // The orchestrator resolves from the conversation, not from the precedence
    // list (which addresses delegated agents and reviewers). Without this the
    // brief's authority has no source: a stale project.md could still win at
    // the point the brief is WRITTEN.
    const stability = entries.find((entry) =>
      entry.startsWith("**Conversation language — stability**"),
    );
    expect(stability, "the stability rule exists").toBeDefined();
    expect(
      stability!.includes(
        "A persisted rule NEVER outranks the brief, and never outranks a later explicit human request to switch",
      ),
      "the stability rule binds the orchestrator as well as the delegate",
    ).toBe(true);
    expect(
      stability!.includes("outranks every other source"),
      "the superseded persisted-rule-wins clause is gone",
    ).toBe(false);
  });

  test("e: two persisted language rules plus an explicit switch still resolve", () => {
    // The review's regression case: an existing persisted language, then an
    // explicit switch, then a delegated stage. The rules are prose, so what is
    // verifiable here is the DELIVERY contract — that the delegate receives
    // BOTH on-disk rules, the brief line, and the precedence rule that decides
    // between them, in one prompt, with the section order the tie-break needs.
    // Whether the model then writes English is model-directed and out of reach
    // of a deterministic test.
    const proj = mkdtempSync(join(tmpdir(), "aidlc-t266-switch-"));
    tempDirs.push(proj);
    const birth = spawnSync(
      BUN,
      [UTILITY, "intent-create", "--scope", "poc", "--arguments", "x", "--project-dir", proj],
      { encoding: "utf-8" },
    );
    expect(birth.status, `intent-create failed: ${birth.stdout}\n${birth.stderr}`).toBe(0);

    // Persist BOTH rules the way the learnings ritual actually leaves them.
    // The write path appends and dedupes on the per-(stage, candidate_id) cid
    // marker, not on the text, so a switch recorded after an earlier language
    // rule does not replace it — the superseded rule stays on disk above the
    // current one. Writing only ONE rule would never exercise the tie-break at
    // all, which is the whole mechanism the fallback clause introduces.
    const projectMd = join(proj, "aidlc", "spaces", "default", "memory", "project.md");
    expect(existsSync(projectMd), "the active space ships project.md").toBe(true);
    const superseded = "Conversation language: Japanese.";
    const current = "Conversation language: English.";
    const body = readFileSync(projectMd, "utf-8");
    expect(body.includes("## Corrections"), "project.md ships ## Corrections").toBe(true);
    writeFileSync(
      projectMd,
      body.replace(
        "## Corrections",
        `## Corrections\n\n- ${superseded}\n- ${current}`,
      ),
      "utf-8",
    );

    // The human has since asked for English, so the orchestrator states English.
    const briefLine = "Conversation language: English";
    const result = augmentDispatchRules(
      "task",
      {
        subagent_type: "aidlc-product-agent",
        prompt: `${briefLine}\n\nExecute the current stage and write its artifacts.`,
      },
      proj,
    );
    expect(result.error ?? null, "dispatch rewrite produced no error").toBeNull();
    expect(result.changed, "the hook rewrote the delegated prompt").toBe(true);

    const prompt = String(result.updatedInput?.prompt ?? "");
    expect(prompt.includes(briefLine), "the brief line survives").toBe(true);
    expect(
      prompt.includes(superseded),
      "the superseded memory rule is delivered too (it is still on disk)",
    ).toBe(true);
    expect(prompt.includes(current), "the current memory rule is delivered").toBe(true);
    expect(
      prompt.includes("AUTHORITATIVE for delegated work"),
      "the delegate also receives the rule that resolves the conflict",
    ).toBe(true);

    // THE TIE-BREAK'S PRECONDITION. The fallback says "the LAST conversation-
    // language rule under `## Corrections` is the current one", which is only
    // decidable if the delivery surface preserves the on-disk ORDER of that
    // section. A bundle that sorted, grouped or deduped its memory lines would
    // leave the delegate unable to apply the rule at all — and every other
    // assertion here would still pass. Pin the ordering the rule depends on.
    const supersededAt = prompt.indexOf(superseded);
    const currentAt = prompt.indexOf(current);
    expect(supersededAt, "the superseded rule is located in the bundle").toBeGreaterThan(-1);
    expect(currentAt, "the current rule is located in the bundle").toBeGreaterThan(-1);
    expect(
      supersededAt < currentAt,
      "the bundle preserves `## Corrections` order, so LAST-one-wins is decidable",
    ).toBe(true);

    // AND THE PRECEDENCE MUST NOT BE POSITIONAL. The bundle is appended after
    // the incoming prompt, so asserting "the brief comes before the rules" only
    // restates that concatenation order — it holds even if the rule ranked
    // memory first. What is worth pinning is the opposite: move the brief line
    // to the END of the prompt and the same three things must still arrive, so
    // the contract rests on the stated ranking rather than on recency.
    const trailing = augmentDispatchRules(
      "task",
      {
        subagent_type: "aidlc-product-agent",
        prompt: `Execute the current stage and write its artifacts.\n\n${briefLine}`,
      },
      proj,
    );
    expect(trailing.error ?? null, "trailing-brief rewrite produced no error").toBeNull();
    const trailingPrompt = String(trailing.updatedInput?.prompt ?? "");
    for (const required of [briefLine, superseded, current, "AUTHORITATIVE for delegated work"]) {
      expect(
        trailingPrompt.includes(required),
        `brief position does not change delivery: ${JSON.stringify(required)}`,
      ).toBe(true);
    }
    expect(
      trailingPrompt.indexOf(superseded) < trailingPrompt.indexOf(current),
      "`## Corrections` order survives regardless of where the brief line sits",
    ).toBe(true);
  });

  // The SPLIT case the (e) pair does not reach: it writes both rules into
  // project.md, so the only ambiguity it exercises is within one file, which
  // LAST-one-wins already settles. The §13 ritual permits project OR team scope,
  // so the real conflict is cross-file — and there, position is actively
  // misleading: aidlc-graph.ts concatenates org → team → project → phase, so a
  // NEWER team-level rule arrives BEFORE a staler project-level one, and a
  // delegate applying "the last one wins" to the bundle would pick the wrong
  // language. This test writes the two rules into two files, dispatches with NO
  // brief language line (the only situation the persisted fallback decides at
  // all), and pins both halves of the fix: that the bundle really does deliver
  // team before project, and that the delegate receives the stated precedence
  // that overrides that order.
  test("e3: a team-level language rule never outranks the project-level one it precedes", () => {
    const proj = mkdtempSync(join(tmpdir(), "aidlc-t266-split-"));
    tempDirs.push(proj);
    const birth = spawnSync(
      BUN,
      [UTILITY, "intent-create", "--scope", "poc", "--arguments", "x", "--project-dir", proj],
      { encoding: "utf-8" },
    );
    expect(birth.status, `intent-create failed: ${birth.stdout}\n${birth.stderr}`).toBe(0);

    const memory = join(proj, "aidlc", "spaces", "default", "memory");
    const teamMd = join(memory, "team.md");
    const projectMd = join(memory, "project.md");
    expect(existsSync(teamMd), "the active space ships team.md").toBe(true);
    expect(existsSync(projectMd), "the active space ships project.md").toBe(true);

    // The team file carries a DEFAULT; the project file carries the switch. Per
    // the rule the project one wins, even though the team one is written second
    // here and reaches the delegate first.
    const teamDefault = "Conversation language: Japanese.";
    const projectCurrent = "Conversation language: English.";
    for (const [path, entry] of [
      [teamMd, teamDefault],
      [projectMd, projectCurrent],
    ] as const) {
      const body = readFileSync(path, "utf-8");
      expect(body.includes("## Corrections"), `${path} ships ## Corrections`).toBe(true);
      writeFileSync(path, body.replace("## Corrections", `## Corrections\n\n- ${entry}`), "utf-8");
    }

    // No `Conversation language:` line: the brief is silent, so (2) decides.
    const result = augmentDispatchRules(
      "task",
      {
        subagent_type: "aidlc-product-agent",
        prompt: "Execute the current stage and write its artifacts.",
      },
      proj,
    );
    expect(result.error ?? null, "dispatch rewrite produced no error").toBeNull();
    expect(result.changed, "the hook rewrote the delegated prompt").toBe(true);
    const prompt = String(result.updatedInput?.prompt ?? "");

    // Both files reach the delegate, so the conflict is real rather than
    // hypothetical — a bundle that dropped team.md would make this test vacuous.
    expect(prompt.includes(teamDefault), "the team-level default is delivered").toBe(true);
    expect(prompt.includes(projectCurrent), "the project-level rule is delivered").toBe(true);

    // THE MISLEADING ORDER, pinned. If this ever flips, the stated precedence
    // stops being load-bearing and the rule can be simplified; while it holds,
    // a positional reading gives the WRONG answer and the rule is required.
    const teamAt = prompt.indexOf(teamDefault);
    const projectAt = prompt.indexOf(projectCurrent);
    expect(teamAt, "the team rule is located in the bundle").toBeGreaterThan(-1);
    expect(projectAt, "the project rule is located in the bundle").toBeGreaterThan(-1);
    expect(
      teamAt < projectAt,
      "the bundle concatenates team before project, so position is not recency",
    ).toBe(true);

    // And the tie-breaker itself is in the same prompt, so the delegate can
    // resolve the conflict from what it was handed rather than guessing.
    for (const clause of [
      "ALWAYS outranks a conversation-language rule in `team.md`",
      "cross-file position is NOT recency",
      "the ONLY file a language switch is ever persisted to",
    ]) {
      expect(
        prompt.includes(clause),
        `the delegate receives the cross-file precedence clause: ${JSON.stringify(clause)}`,
      ).toBe(true);
    }
  });

  // The (e) pair proves the bundle DELIVERS a stale persisted rule, the fresh
  // brief line, and the precedence rule into one prompt, and that the order the
  // tie-break needs survives. It does that by writing both rules and injecting
  // `Conversation language: English` itself — so it proves delivery, not that
  // the conductor noticed the switch and regenerated that line. Regenerating it
  // is model behaviour: no assertion can force a model to emit a line, and
  // having the engine emit it instead would be a change to the dispatch path
  // rather than to the rule layer. What IS checkable is that the
  // obligation exists, names the orchestrator rather than only the delegate, and
  // cannot be satisfied by a stale file — the three ways the rule could fail to
  // bind the conductor even with a perfectly compliant model. Delivery of this
  // obligation to the conductor's own context is (c3).
  test("e2: the explicit-switch obligation binds the orchestrator, not just delegates", () => {
    const entries = sectionEntries(readFileSync(AUTHORED_ORG_MD, "utf-8"), "Mandated");
    const resolution = entries.find((e) =>
      e.startsWith("**Conversation language — resolution**"),
    );
    const stability = entries.find((e) => e.startsWith("**Conversation language — stability**"));
    expect(resolution, "the resolution rule exists").toBeDefined();
    expect(stability, "the stability rule exists").toBeDefined();

    // (1) The orchestrator — not the delegate — is the party obliged to emit the
    // line, and it is obliged on EVERY dispatch, so a switch cannot be honoured
    // once and then forgotten.
    expect(
      /orchestrator[^.]*\bMUST\b[^.]*`Conversation language: <language>` line in every delegated brief/.test(
        resolution as string,
      ),
      "the resolution rule puts the per-dispatch obligation on the orchestrator",
    ).toBe(true);

    // (2) After an explicit switch the orchestrator must state the NEW language
    // in every SUBSEQUENT brief. Without "subsequent" the rule would be
    // satisfiable by the brief that happened to be in flight.
    const restates =
      /the orchestrator states the new language in the `Conversation language:` line of every subsequent delegated brief/;
    expect(
      restates.test(stability as string),
      "the stability rule obliges the orchestrator to restate the new language on every later brief",
    ).toBe(true);

    // (3) The switch is immediate, and a persisted rule cannot outrank it. This
    // is what stops a conductor from reading `project.md` and concluding the
    // human's request was already answered — the scenario that produced the
    // review finding this rule family was rewritten for.
    expect(
      /takes effect IMMEDIATELY/.test(stability as string),
      "an explicit switch takes effect immediately, not at the next persistence step",
    ).toBe(true);
    expect(
      /A persisted rule NEVER outranks the brief, and never outranks a later explicit human request to switch/.test(
        stability as string,
      ),
      "a persisted rule outranks neither the brief nor a later explicit switch request",
    ).toBe(true);

    // (4) The obligation must not be reachable only through the delegate path.
    // The conductor reads the same `## Mandated` section, so the rule text has
    // to address it by name somewhere in the family; if a rewrite ever scoped
    // every clause to "delegated agents and reviewers", the conductor would be
    // unbound again — exactly the gap the second review round found.
    const family = [resolution as string, stability as string].join("\n");
    expect(
      /\borchestrator\b/.test(family),
      "the rule family binds the orchestrator explicitly, not only delegated agents",
    ).toBe(true);
  });

  // === (f) WRITE PATH ======================================================
  // Field-verified defect. The rule used to say "record the switch as a
  // single-line rule under `## Corrections` in project.md" — an imperative
  // addressed to the agent — and only mentioned the §13 ritual parenthetically.
  // A live run read that as licence to write memory itself: the orchestrator
  // hand-edited project.md after the human answered "Nothing to add", which
  // skipped aidlc-learnings.ts entirely (no RULE_LEARNED audit event, no cid
  // duplicate key, no admission conflict-check) and overrode an explicit human
  // answer. It justified this with the rule's own "never wait for persistence".
  //
  // Persistence is worth nothing here anyway: the brief is authoritative, so a
  // declined persistence costs the workflow nothing. The rule must therefore
  // name the ritual as the ONLY write path and forbid a direct edit outright.
  test("f: only the §13 ritual may persist a switch; a direct memory write is forbidden", () => {
    const entries = sectionEntries(readFileSync(AUTHORED_ORG_MD, "utf-8"), "Mandated");
    const rule = entries.find((entry) =>
      entry.startsWith("**Conversation language — stability**"),
    );
    expect(rule, "the stability rule exists").toBeDefined();

    // Two regressions must not come back, in the authored source OR in any
    // shipped projection: the imperative that caused the direct write, and the
    // unscoped write-path claim that countermanded the deterministic promotion
    // writer (practices-discovery Step 7 runs `aidlc-state.ts practices-promote`,
    // which replaces five sections of `team.md` and appends to `project.md`).
    const forbidden = [
      "record the switch as a single-line rule under",
      "ONLY sanctioned write path into",
    ];
    for (const { label, text } of [
      { label: "core/memory/org.md", text: readFileSync(AUTHORED_ORG_MD, "utf-8") },
      ...orgMdProjections().map(({ label, path }) => ({
        label,
        text: readFileSync(path, "utf-8"),
      })),
    ]) {
      for (const phrase of forbidden) {
        expect(text.includes(phrase), `${label} must not contain "${phrase}"`).toBe(false);
      }
    }

    expect(
      rule!.includes("the §13 learnings ritual is the ONLY sanctioned write path"),
      "the ritual is named as the only write path",
    ).toBe(true);
    // Scoped: the prohibition covers persisting a language switch and a direct
    // agent edit, not every write into the active-space memory tree.
    expect(
      rule!.includes(
        "the ONLY sanctioned write path for persisting a conversation-language switch",
      ),
      "the write-path prohibition is scoped to language-switch persistence",
    ).toBe(true);
    expect(
      rule!.includes("practices-promote"),
      "the deterministic promotion writer is named as out of scope",
    ).toBe(true);
    expect(
      rule!.includes("NEVER edit a memory file directly"),
      "a direct memory edit is forbidden outright",
    ).toBe(true);
    // The exact rationalisation the live run used, closed explicitly.
    expect(
      rule!.includes('"do not wait for persistence" is never licence to bypass that gate'),
      "\"never wait\" cannot be read as licence to bypass the human gate",
    ).toBe(true);
    // Declining must be a valid outcome, not a gap the agent should route around.
    expect(
      rule!.includes("when the human declines, it is simply not persisted"),
      "a declined persistence is a correct outcome",
    ).toBe(true);
  });

  // Negative space for the write-path prohibition. The positive assertions in
  // (f) prove the scoped claim is present; they do NOT stop a second, unscoped
  // claim from being appended beside it. An unscoped claim over the memory tree
  // countermands the deterministic writers a stage invokes by contract —
  // practices-discovery Step 7 runs `aidlc-state.ts practices-promote`, which
  // replaces five sections of `team.md` and appends to `project.md`
  // (core/aidlc-common/stages/inception/practices-discovery.md,
  // core/tools/aidlc-state.ts). So every reference to the memory tree that sits
  // near a write/edit verb has to be scoped to a language switch, whatever the
  // wording. Pinning one past phrasing would only pin the one regression.
  test("f2: no ## Mandated claim asserts an unscoped write monopoly over the memory tree", () => {
    const MEMORY_REFS = [
      "aidlc/spaces/<active-space>/memory/",
      "memory tree",
      "memory file",
      "memory directory",
    ];
    const WRITE_VERB = /\b(write|writes|writing|wrote|edit|edits|editing)\b/i;
    const LANGUAGE_SCOPE = /\bswitch\b/i;

    // Clause-bounded, not a character window: a window bleeds into the next
    // sentence and would pick up its `switch` mention, which is exactly how an
    // appended claim slipped past an earlier draft of this test. Periods inside
    // inline code (`project.md`, `aidlc-state.ts`) are masked with a private-use
    // sentinel before splitting so they cannot end a clause.
    const DOT = "\uE000";
    const clausesOf = (entry: string): string[] =>
      entry
        .replace(/`[^`]*`/g, (code) => code.replaceAll(".", DOT))
        .split(/(?:[.;]\s+|\s—\s)/)
        .map((clause) => clause.replaceAll(DOT, ".").trim())
        .filter((clause) => clause.length > 0);

    const entries = sectionEntries(readFileSync(AUTHORED_ORG_MD, "utf-8"), "Mandated");
    expect(entries.length, "the Mandated section has entries to scan").toBeGreaterThan(0);

    let scanned = 0;
    for (const entry of entries) {
      for (const clause of clausesOf(entry)) {
        if (!MEMORY_REFS.some((ref) => clause.includes(ref))) continue;
        if (!WRITE_VERB.test(clause)) continue;
        scanned += 1;
        expect(
          LANGUAGE_SCOPE.test(clause),
          `an unscoped write claim over the memory tree countermands practices-promote: "${clause}"`,
        ).toBe(true);
      }
    }
    // The scoped claim in the stability rule must be one of the sites we saw,
    // so a refactor that removes the prohibition cannot make this test vacuous.
    expect(scanned, "at least the scoped write-path claim was scanned").toBeGreaterThan(0);
  });
});
