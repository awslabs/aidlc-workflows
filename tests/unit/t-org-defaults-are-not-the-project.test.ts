// covers: file:core/memory/org.md
//
// Two live runs asked AI-DLC to commit a finished one-file fix. It ran `git
// checkout -b fix/greeter-name` and said "this project merges work in from
// short-lived branches" and "squash-merge it the way this project does". The
// project had said nothing of the kind: both lines came from the framework's
// own `org.md`, whose `## Way of Working` was written in the first person ("We
// use trunk-based development. All work merges to `main` via short-lived
// feature branches"), so the agent read a shipped default as the project's
// practice and made a branch nobody had asked for.
//
// The section now says whose defaults they are, and says where a commit the
// person asks for goes. Two things are pinned here:
//   (a) the framing: the section names AI-DLC's defaults and the two files
//       that replace them, and never speaks as the project ("we"/"our");
//   (b) the sentence `aidlc-unit.ts` parses. affirmedIntegrationBranch reads
//       `## Way of Working` for a "base branch" or "merge target" with the
//       name in backticks in the same sentence, narrowest layer first, and
//       org.md is the layer that answers when a team wrote nothing (the
//       fallback t325 relies on). A rewrite that drops that sentence would
//       silently change which branch team claims use.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

// The shipped `## Way of Working` body, as the rule bundle delivers it.
function wayOfWorking(): string {
  const body = readFileSync(join(REPO_ROOT, "core", "memory", "org.md"), "utf-8");
  const from = body.indexOf("## Way of Working");
  expect(from, "core/memory/org.md has no `## Way of Working` heading").toBeGreaterThan(-1);
  const rest = body.slice(from + "## Way of Working".length);
  const to = rest.indexOf("\n## ");
  return to === -1 ? rest : rest.slice(0, to);
}

describe("org.md's defaults never speak as the person's project", () => {
  test("the section says whose defaults they are, and that a commit goes where the person is", () => {
    const section = wayOfWorking();
    expect(section).toContain("AI-DLC's own defaults");
    expect(section).toContain("team.md");
    expect(section).toContain("project.md");
    // The live break: a commit the person asked for went onto a new branch.
    expect(section).toMatch(/commit you ask for goes where you already are/);
    expect(section).toMatch(/makes a branch for it only when you ask for one/);
  });

  test("it never claims the project's own practice", () => {
    for (const claim of ["We use", "we use", "our project", "All work merges", "we avoid", "gives us"]) {
      expect(wayOfWorking(), `org.md speaks as the project: "${claim}"`).not.toContain(claim);
    }
  });

  test("the base branch and merge target stay in the shape aidlc-unit.ts parses", () => {
    const section = wayOfWorking();
    // The two regexes in affirmedIntegrationBranch: the words, then the name
    // in backticks in the same sentence (no backtick, newline, period or
    // semicolon between them).
    const words = "(?:(?:base|integration|merge[ -]target) branch|merge target)";
    expect(section).toMatch(new RegExp(`\\b${words}\\b[^\`\\n.;]*\`main\``, "i"));
    expect(section).toMatch(/merge target is `main`/);
    // The two facts the hardcoded-defaults table in
    // core/knowledge/aidlc-shared/rules-reading.md still names as this layer's.
    expect(section).toContain("trunk-based development");
    expect(section).toContain("squash-merge");
  });
});
