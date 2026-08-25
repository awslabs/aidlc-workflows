// covers: hook:aidlc-state-transition-guard, subcommand:aidlc-state(lifecycle-owner-guard)
//
// The hook provides immediate PreToolUse feedback and the state CLI repeats the
// same ownership boundary as the harness-independent hard floor.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  BLOCKED_STATE_TRANSITIONS,
  DELEGATED_STATE_MUTATIONS,
  delegatedLifecycleCommand,
  directStateTransition,
  isLifecycleBoundaryCommand,
} from "../../dist/claude/.claude/hooks/aidlc-state-transition-guard.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOK = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "hooks",
  "aidlc-state-transition-guard.ts",
);
const STATE = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-state.ts",
);
const ORCHESTRATE = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-orchestrate.ts",
);
const UTILITY = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);
const BLOCKED = [
  "set",
  "checkbox",
  "advance",
  "finalize",
  "complete-workflow",
  "gate-start",
  "approve",
  "reject",
  "revise",
  "skip",
  "park",
] as const;
const STAGES_ROOT = join(REPO_ROOT, "core", "aidlc-common", "stages");
const NON_INITIALIZATION_STAGES = [
  "ideation",
  "inception",
  "construction",
  "operation",
].flatMap((phase) =>
  readdirSync(join(STAGES_ROOT, phase))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(STAGES_ROOT, phase, name))
).sort();
const DIRECT_LIFECYCLE_VERB = new RegExp(
  String.raw`aidlc-state\.ts\s+(?:${BLOCKED.join("|")})(?=\s|$)`,
);
const DIRECT_CHECKBOX_COMPLETION =
  /\b(?:mark|update)\b[^\n]*`\[x\]`[^\n]*\bcomplete(?:d)?\b/i;
const DIRECT_STATE_HEADING = /^### Step \d+: .*Update State\b/m;
const DIRECT_PHASE_BOOKKEEPING =
  /\b(?:update|set)\s+(?:the\s+)?Lifecycle Phase\b|\bmark\s+(?:IDEATION|INCEPTION|CONSTRUCTION|OPERATION)\s+phase\s+(?:as\s+)?complete\b/i;

const projects: string[] = [];
afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

function unownedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AIDLC_STATE_TRANSITION_OWNER;
  delete env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS;
  return env;
}

describe("t242 state-transition ownership guard", () => {
  test("the hook blocks every lifecycle verb at an actual shell command position", () => {
    expect([...BLOCKED_STATE_TRANSITIONS]).toEqual([...BLOCKED]);
    for (const verb of BLOCKED) {
      expect(
        directStateTransition(
          `cd /tmp && env AIDLC_TEST=1 bun run ".claude/tools/aidlc-state.ts" ${verb} fixture`,
        ),
      ).toBe(verb);
    }
  });

  test("read/config/recovery verbs and command text passed to echo or rg remain allowed", () => {
    for (const verb of [
      "get",
      "set-skeleton-stance",
      "set-construction-iteration",
      "count",
      "resume",
      "acknowledge-compaction",
      "reuse-artifact",
      "lookup",
      "practices-event",
      "practices-promote",
      "fork",
      "merge",
      "unpark",
    ]) {
      expect(
        directStateTransition(
          `bun .claude/tools/aidlc-state.ts ${verb} fixture`,
        ),
      ).toBeNull();
    }
    for (const command of [
      "echo bun .claude/tools/aidlc-state.ts approve feasibility",
      "rg bun .claude/tools/aidlc-state.ts reject docs/",
      "printf '%s' 'bun .claude/tools/aidlc-state.ts advance feasibility'",
      "echo 'example; bun .claude/tools/aidlc-state.ts approve feasibility'",
      "rg 'aidlc-state\\.ts (approve|reject)' .",
      "cat <<'EOF'\nbun .claude/tools/aidlc-state.ts approve feasibility\nEOF",
      "payload='first line\nbun .claude/tools/aidlc-state.ts reject feasibility\nlast line'",
      "run_transition() {\n  bun .claude/tools/aidlc-state.ts advance feasibility\n}",
      "function run_transition {\n  bun .claude/tools/aidlc-state.ts skip feasibility\n}",
    ]) {
      expect(directStateTransition(command), command).toBeNull();
    }
  });

  test("lifecycle detection distinguishes quoted prose from executable command substitution", () => {
    expect(
      isLifecycleBoundaryCommand(
        `echo "example; bun .claude/tools/aidlc-orchestrate.ts report --stage feasibility --result completed"`,
      ),
    ).toBe(false);
    expect(
      isLifecycleBoundaryCommand(
        `result="$(bun .claude/tools/aidlc-orchestrate.ts report --stage feasibility --result completed)"`,
      ),
    ).toBe(true);
  });

  test("delegated agents cannot invoke workflow lifecycle or routing entrypoints", () => {
    for (const [command, expected] of [
      ["bun .claude/tools/aidlc-orchestrate.ts next --resume", "aidlc-orchestrate.ts next"],
      [
        "bun .claude/tools/aidlc-orchestrate.ts report --result resumed --user-input 1",
        "aidlc-orchestrate.ts report",
      ],
      ["bun .claude/tools/aidlc-orchestrate.ts park", "aidlc-orchestrate.ts park"],
      [
        "bun .claude/tools/aidlc-orchestrate.ts continue steering-token",
        "aidlc-orchestrate.ts continue",
      ],
      ["bun .claude/tools/aidlc-state.ts unpark", "aidlc-state.ts unpark"],
      [
        "bun .claude/tools/aidlc-jump.ts execute --target requirements-analysis",
        "aidlc-jump.ts execute",
      ],
      [
        "bun .claude/tools/aidlc-utility.ts recompose --add user-stories",
        "aidlc-utility.ts recompose",
      ],
      [
        'bash -lc "bun .claude/tools/aidlc-orchestrate.ts next --resume"',
        "aidlc-orchestrate.ts next",
      ],
      [
        'sh -c "bun .claude/tools/aidlc-state.ts unpark"',
        "aidlc-state.ts unpark",
      ],
      [
        'bash --noprofile -e -c "bun .claude/tools/aidlc-orchestrate.ts next --resume"',
        "aidlc-orchestrate.ts next",
      ],
      [
        'zsh -o NO_RCS -c "bun .claude/tools/aidlc-state.ts unpark"',
        "aidlc-state.ts unpark",
      ],
      [
        'dash -c "bun .claude/tools/aidlc-orchestrate.ts continue steering-token"',
        "aidlc-orchestrate.ts continue",
      ],
      [
        "bun .claude/tools/aidlc-orchestrate.ts --project-dir /tmp next --resume",
        "aidlc-orchestrate.ts next",
      ],
      [
        "bun .claude/tools/aidlc-state.ts --project-dir /tmp unpark",
        "aidlc-state.ts unpark",
      ],
      [">/tmp/aidlc-output aidlc next --resume", "aidlc next"],
      ["AIDLC_TEST=1 >/tmp/aidlc-output aidlc next --resume", "aidlc next"],
      ["if aidlc next --resume; then :; fi", "aidlc next"],
      [
        "while bun .claude/tools/aidlc-state.ts unpark; do :; done",
        "aidlc-state.ts unpark",
      ],
      [
        "bun --silent .claude/tools/aidlc-state.ts unpark",
        "aidlc-state.ts unpark",
      ],
      ["f(){ aidlc next --resume; }; f", "aidlc next"],
      ['eval "aidlc next --resume"', "aidlc next"],
      ['env -S "aidlc next --resume"', "aidlc next"],
      ['env -S"aidlc next --resume"', "aidlc next"],
      ['env --split-string="aidlc next --resume"', "aidlc next"],
      ["env env aidlc next --resume", "aidlc next"],
      ["command env env aidlc next --resume", "aidlc next"],
      ["env --block-signal env aidlc next --resume", "aidlc next"],
      ["env --list-signal-handling aidlc next --resume", "aidlc next"],
      ["env -P >out /usr/bin aidlc next --resume", "aidlc next"],
      ["nice aidlc next --resume", "aidlc next"],
      ["nohup aidlc next --resume", "aidlc next"],
      ["env >out aidlc next --resume", "aidlc next"],
      ["env -u >out PATH aidlc next --resume", "aidlc next"],
      ['env -S >out "aidlc next --resume"', "aidlc next"],
      ["nice >out aidlc next --resume", "aidlc next"],
      ["nice -n >out 5 aidlc next --resume", "aidlc next"],
      ["nohup 2>/dev/null aidlc next --resume", "aidlc next"],
      ["exec -a >out aidlc-alias aidlc next --resume", "aidlc next"],
      ['eval -- "aidlc next --resume"', "aidlc next"],
      ["time -p aidlc next --resume", "aidlc next"],
      ["bash -c $'aidlc next --resume'", "aidlc next"],
      ["aidlc \\\nnext --resume", "aidlc next"],
      ["bun .claude/tools/aidlc.ts --resume", "aidlc.ts --resume"],
      [
        "bun .claude/tools/aidlc.ts --project-dir /tmp next --resume",
        "aidlc.ts next",
      ],
      [
        "bun .claude/tools/aidlc.ts intent other-intent",
        "aidlc.ts intent other-intent",
      ],
      [
        "bun .claude/tools/aidlc.ts space other-space",
        "aidlc.ts space other-space",
      ],
      [
        "bun .claude/tools/aidlc.ts intent switch other-intent",
        "aidlc.ts intent switch",
      ],
      ["bun .claude/tools/aidlc.ts intent create", "aidlc.ts intent create"],
      [
        "bun .claude/tools/aidlc.ts space create other-space",
        "aidlc.ts space create",
      ],
      [
        "bun .claude/tools/aidlc-utility.ts intent other-intent",
        "aidlc-utility.ts intent other-intent",
      ],
      [
        "bun .claude/tools/aidlc-utility.ts space other-space",
        "aidlc-utility.ts space other-space",
      ],
      [
        "bun .claude/tools/aidlc-utility.ts --project-dir /tmp space-create other-space",
        "aidlc-utility.ts space-create",
      ],
      [
        "bun .claude/tools/aidlc-utility.ts intent-create --scope feature",
        "aidlc-utility.ts intent-create",
      ],
      ["aidlc next --resume", "aidlc next"],
      ["aidlc continue steering-token", "aidlc continue"],
      ["aidlc report --result resumed --user-input 1", "aidlc report"],
      ["aidlc state unpark", "aidlc state unpark"],
      ["aidlc scope change --scope mvp", "aidlc scope change"],
      ["aidlc config-change --depth comprehensive", "aidlc config-change"],
      ["aidlc intent other-intent", "aidlc intent other-intent"],
      ["aidlc space other-space", "aidlc space other-space"],
      ["aidlc --project-dir /tmp space-create other-space", "aidlc space-create"],
      [
        "cd project && aidlc jump execute --target requirements-analysis",
        "aidlc jump execute",
      ],
      ["env AIDLC_TEST=1 aidlc config set --depth comprehensive", "aidlc config set"],
      [
        'echo "$(bun .claude/tools/aidlc-state.ts unpark)"',
        "aidlc-state.ts unpark",
      ],
      ["result=`aidlc next --resume`", "aidlc next"],
      ["cat <<EOF\n$(aidlc next --resume)\nEOF", "aidlc next"],
      ['sh -c -- "aidlc next --resume"', "aidlc next"],
      ['cmd="aidlc next --resume"; bash -c "$cmd"', "aidlc next"],
      ['cmd=aidlc; "$cmd" next --resume', "aidlc next"],
      [`cmd=aidlc; \${cmd} next --resume`, "aidlc next"],
      [`"\${cmd:-aidlc}" next --resume`, "dynamic executable beyond guard inspection"],
      [
        `bash -c "\${cmd:-aidlc next --resume}"`,
        "dynamic shell command beyond guard inspection",
      ],
      ['c=aidlc; d=$c; "$d" next --resume', "dynamic executable beyond guard inspection"],
    ] as const) {
      expect(delegatedLifecycleCommand(command), command).toBe(expected);
    }
    let nested = "aidlc next --resume";
    for (let i = 0; i < 9; i++) nested = `bash -c ${JSON.stringify(nested)}`;
    expect(delegatedLifecycleCommand(nested)).not.toBeNull();
    expect(DELEGATED_STATE_MUTATIONS.has("unpark")).toBe(true);
    expect(
      delegatedLifecycleCommand("bun .claude/tools/aidlc-state.ts get 'Current Stage'"),
    ).toBeNull();
    expect(
      delegatedLifecycleCommand("bun .claude/tools/aidlc-orchestrate.ts --help"),
    ).toBeNull();
    for (const command of [
      "bun .claude/tools/aidlc.ts intent",
      "bun .claude/tools/aidlc.ts intent list",
      "bun .claude/tools/aidlc.ts intent --json",
      "bun .claude/tools/aidlc.ts space",
      "bun .claude/tools/aidlc.ts space list",
      "bun .claude/tools/aidlc.ts space help",
      "bun .claude/tools/aidlc-utility.ts intent",
      "bun .claude/tools/aidlc-utility.ts intent list",
      "bun .claude/tools/aidlc-utility.ts intent --json",
      "bun .claude/tools/aidlc-utility.ts space",
      "bun .claude/tools/aidlc-utility.ts space list",
      "bun .claude/tools/aidlc-utility.ts space help",
      "bun .claude/tools/aidlc-utility.ts --project-dir /tmp space list",
      "aidlc intent",
      "aidlc intent list",
      "aidlc intent --json",
      "aidlc space",
      "aidlc space list",
      "aidlc space help",
      "aidlc --project-dir /tmp intent list",
      "echo ok # ; aidlc next --resume",
      "cat <<'EOF'\n$(aidlc next --resume)\nEOF",
      "command -v aidlc next --resume",
      "eval true",
      'eval "echo ok"',
      "env -0 aidlc next --resume",
      "nice --adjustment=bogus aidlc next --resume",
      "nice --help",
      "nohup --version",
    ]) {
      expect(delegatedLifecycleCommand(command), command).toBeNull();
    }
    expect(delegatedLifecycleCommand('bash -c "$unresolved"')).toBe(
      "dynamic shell command beyond guard inspection",
    );
    expect(delegatedLifecycleCommand('"$unresolved" --version')).toBe(
      "dynamic executable beyond guard inspection",
    );
    expect(delegatedLifecycleCommand('eval "$command"')).toBe(
      "dynamic eval shell command beyond guard inspection",
    );
    expect(delegatedLifecycleCommand(String.raw`eval 'printf %s \$HOME'`)).toBe(
      "dynamic eval shell command beyond guard inspection",
    );
    expect(
      delegatedLifecycleCommand("eval \"$(printf 'aidlc next --resume')\""),
    ).toBe(
      "dynamic eval shell command beyond guard inspection",
    );
    expect(delegatedLifecycleCommand(String.raw`env -S 'aidlc\_next --resume'`)).toBe(
      "execution wrapper beyond guard inspection",
    );
    expect(
      delegatedLifecycleCommand(
        "echo 'bun .claude/tools/aidlc-orchestrate.ts next --resume'",
      ),
    ).toBeNull();
    expect(
      delegatedLifecycleCommand(
        'printf %s \'bash -lc "bun .claude/tools/aidlc-orchestrate.ts next --resume"\'',
      ),
    ).toBeNull();
    expect(
      delegatedLifecycleCommand(
        "printf %s '$(aidlc next --resume)'",
      ),
    ).toBeNull();
    expect(
      delegatedLifecycleCommand(
        "echo '`aidlc space other-space`'",
      ),
    ).toBeNull();
  });

  test("the hook blocks delegated lifecycle commands but permits the conductor", () => {
    const command = "bun .claude/tools/aidlc-orchestrate.ts next --resume";
    const delegated = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        agent_type: "aidlc-product-lead-agent",
      }),
      encoding: "utf-8",
      env: unownedEnv(),
    });
    expect(delegated.status).toBe(2);
    expect(delegated.stderr).toContain("workflow lifecycle and routing are conductor-owned");

    const conductor = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
      encoding: "utf-8",
      env: unownedEnv(),
    });
    expect(conductor.status).toBe(0);
    expect(conductor.stderr).toBe("");
  });

  test("the hook blocks delegated lifecycle commands behind wrappers and literal variables", () => {
    for (const command of [
      "env env aidlc next --resume",
      "command env env aidlc next --resume",
      "nice aidlc next --resume",
      "nohup aidlc next --resume",
      "aidlc scope change --scope mvp",
      "aidlc config-change --depth comprehensive",
      'sh -c -- "aidlc next --resume"',
      'cmd="aidlc next --resume"; bash -c "$cmd"',
      'cmd=aidlc; "$cmd" next --resume',
      `cmd=aidlc; \${cmd} next --resume`,
      `"\${cmd:-aidlc}" next --resume`,
      `bash -c "\${cmd:-aidlc next --resume}"`,
      'c=aidlc; d=$c; "$d" next --resume',
    ]) {
      const delegated = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          agent_type: "aidlc-product-lead-agent",
        }),
        encoding: "utf-8",
        env: unownedEnv(),
      });
      expect(delegated.status, command).toBe(2);
      expect(delegated.stderr, command).toContain(
        "workflow lifecycle and routing are conductor-owned",
      );
    }
  });

  test("large heredoc writes stay fast (whitespace-quadratic regression pin)", () => {
    // The hook fires on EVERY Bash call; masked heredoc bodies become long
    // whitespace runs, and a cross-line \s* after the parser's line anchors
    // once made this quadratic (a 5000-line generated-file write cost ~3s per
    // call, enough to trip Kiro's 15s hook timeout on larger files). Pin the
    // linear behaviour with a generous ceiling: the fixed parser runs these in
    // tens of milliseconds; the quadratic one takes seconds.
    const body = Array.from(
      { length: 5000 },
      (_, i) => `  const line${i} = compute(${i}); // generated filler`,
    ).join("\n");
    const closed = `cat > generated.ts <<'EOF'\n${body}\nEOF`;
    const unterminated = `cat > generated.ts <<'EOF'\n${
      Array.from({ length: 50000 }, () => "x".repeat(60)).join("\n")
    }\n`;
    for (const [label, command, verdict] of [
      ["closed-5000-line", closed, null],
      ["unterminated-50k-line", unterminated, null],
      [
        "closed-5000-line-then-real-call",
        `${closed}\nbun .claude/tools/aidlc-state.ts approve feasibility`,
        "approve",
      ],
      // Runs of { or ( are runs of invocation-anchor positions; a path-prefix
      // class that can consume them rescans the remainder from every anchor -
      // quadratic even with the heredoc fix in place (a 160k brace argument
      // once cost ~42s, past Kiro's 15s hook cap).
      [
        "160k-brace-run-single-line",
        `git commit -m ${"{".repeat(160000)}`,
        null,
      ],
      [
        "160k-paren-run-then-real-call",
        `${"(".repeat(160000)}\nbun .claude/tools/aidlc-state.ts approve feasibility`,
        "approve",
      ],
    ] as const) {
      const start = performance.now();
      const result = directStateTransition(command);
      const elapsed = performance.now() - start;
      expect(result, label).toBe(verdict);
      expect(elapsed, `${label} took ${elapsed.toFixed(0)}ms`).toBeLessThan(
        2000,
      );
    }
  });

  test("the Claude hook exits 2 with a redirecting stderr reason", () => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command:
            "bun .claude/tools/aidlc-state.ts gate-start feasibility",
        },
      }),
      encoding: "utf-8",
      env: unownedEnv(),
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(
      "Direct aidlc-state.ts gate-start is blocked",
    );
    expect(r.stderr).toContain("aidlc-orchestrate.ts report");
  });

  test("the state CLI rejects every unowned lifecycle verb before dispatch", () => {
    const project = createTestProject();
    projects.push(project);
    for (const verb of BLOCKED) {
      const r = spawnSync(
        process.execPath,
        [STATE, verb, "fixture", "--project-dir", project],
        {
          encoding: "utf-8",
          env: unownedEnv(),
        },
      );
      expect(r.status, `${verb}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toContain(
        `Direct aidlc-state.ts ${verb} is blocked`,
      );
    }
  });

  test("a copied static owner token does not authorize a direct state transition", () => {
    const project = createTestProject();
    projects.push(project);
    seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const env = unownedEnv();
    env.AIDLC_STATE_TRANSITION_OWNER = "orchestrate";
    const r = spawnSync(
      process.execPath,
      [STATE, "gate-start", "feasibility", "--project-dir", project],
      { encoding: "utf-8", env },
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain(
      "Direct aidlc-state.ts gate-start is blocked",
    );
  });

  test("report propagates parent-bound ownership with both caller ownership vars cleared", () => {
    const project = createTestProject();
    projects.push(project);
    seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const env = unownedEnv();
    env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
    const r = spawnSync(
      process.execPath,
      [
        ORCHESTRATE,
        "report",
        "--stage",
        "feasibility",
        "--result",
        "awaiting-approval",
        "--project-dir",
        project,
      ],
      { encoding: "utf-8", env },
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("Recorded awaiting-approval");
    expect(readFileSync(seededStateFile(project), "utf-8")).toContain(
      "- [?] feasibility",
    );
  });

  test("production reports require approval input and rejection feedback", () => {
    for (const result of ["approved", "rejected"] as const) {
      const project = createTestProject();
      projects.push(project);
      seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
      const env = unownedEnv();
      env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
      delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
      const r = spawnSync(
        process.execPath,
        [
          ORCHESTRATE,
          "report",
          "--stage",
          "feasibility",
          "--result",
          result,
          "--project-dir",
          project,
        ],
        { encoding: "utf-8", env },
      );
      expect(r.status, `${result}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout, result).toContain('"kind":"error"');
      expect(r.stdout, result).toContain("did not match an offered choice");
      expect(r.stdout, result).toContain("original held gate with every offered choice");
      expect(readFileSync(seededStateFile(project), "utf-8"), result).toContain(
        "- [-] feasibility",
      );
    }
  });

  test("set-status rejects callers other than the statusline hook", () => {
    const project = createTestProject();
    projects.push(project);
    seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const env = { ...process.env };
    delete env.AIDLC_STATUSLINE_OWNER;
    const r = spawnSync(
      process.execPath,
      [
        UTILITY,
        "set-status",
        "--stage",
        "scope-definition",
        "--project-dir",
        project,
      ],
      { encoding: "utf-8", env },
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain(
      "status synchronization is owned by the sync-workflow-state hook",
    );
  });

  test("the state CLI still permits read-only access without an owner marker", () => {
    const project = createTestProject();
    projects.push(project);
    seedStateFile(
      project,
      join(FIXTURES_DIR, "state-mid-ideation.md"),
    );
    const r = spawnSync(
      process.execPath,
      [STATE, "get", "Current Stage", "--project-dir", project],
      {
        encoding: "utf-8",
        env: unownedEnv(),
      },
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout.trim()).toBe("feasibility");
  });

  test("non-initialization stages delegate lifecycle transitions and owned Learn writes", () => {
    expect(NON_INITIALIZATION_STAGES).toHaveLength(30);
    for (const path of NON_INITIALIZATION_STAGES) {
      const body = readFileSync(path, "utf-8");
      const label = relative(REPO_ROOT, path);
      const slug = basename(path, ".md");

      expect(body, label).toMatch(
        new RegExp(
          String.raw`aidlc-orchestrate\.ts report\s+--stage\s+${slug}\b`,
        ),
      );
      expect(body, label).not.toMatch(DIRECT_LIFECYCLE_VERB);
      expect(body, label).not.toMatch(DIRECT_CHECKBOX_COMPLETION);
      expect(body, label).not.toMatch(DIRECT_STATE_HEADING);
      expect(body, label).not.toMatch(DIRECT_PHASE_BOOKKEEPING);

      if (slug === "practices-discovery") continue;
      // The Learn routing must match what §13 and aidlc-learnings.ts actually
      // write: project.md (default) / team.md (promoted). No phases/ tier, no
      // org tier — the tool has no write path for either.
      expect(body, label).toContain(
        "`aidlc/spaces/<active-space>/memory/project.md` (default) or `team.md` (promoted)",
      );
      expect(body, label).not.toContain("memory/phases/<phase>.md");
      expect(body, label).not.toContain("memory/<org|team|project>.md");
      expect(body, label).not.toContain(
        "{{HARNESS_DIR}}/rules/aidlc-phase-<phase>.md",
      );
      expect(body, label).not.toContain(
        "{{HARNESS_DIR}}/rules/aidlc-<org|team|project>.md",
      );
      expect(body, label).not.toContain("{{HARNESS_DIR}}/rules/");
    }
  });

  test("conditional skips and opt-in stages use engine-owned commands", () => {
    const stage = (phase: string, slug: string): string =>
      readFileSync(join(STAGES_ROOT, phase, `${slug}.md`), "utf-8");

    expect(stage("inception", "reverse-engineering")).toContain(
      'bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage reverse-engineering --result skipped --reason "<reason>"',
    );
    expect(stage("inception", "user-stories")).toContain(
      'bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage user-stories --result skipped --reason "<reason>"',
    );
    expect(stage("inception", "requirements-analysis")).toContain(
      "bun {{HARNESS_DIR}}/tools/aidlc-utility.ts recompose --add user-stories",
    );
    expect(stage("inception", "domain-design")).toContain(
      "bun {{HARNESS_DIR}}/tools/aidlc-utility.ts recompose --add units-generation",
    );
  });
});
