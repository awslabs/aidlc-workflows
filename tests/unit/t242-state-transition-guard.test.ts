// covers: hook:aidlc-state-transition-guard, subcommand:aidlc-state(lifecycle-owner-guard)
//
// The hook provides immediate PreToolUse feedback and the state CLI repeats the
// same ownership boundary as the harness-independent hard floor.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  BLOCKED_STATE_TRANSITIONS,
  DELEGATED_STATE_MUTATIONS,
  delegatedLifecycleCommand,
  directStateTransition,
  isLifecycleBoundaryCommand,
} from "../../dist/claude/.claude/hooks/aidlc-state-transition-guard.ts";
import { violatesRuntimeIntegrity } from "../../dist/claude/.claude/hooks/runtime-integrity.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seededStateFile,
  seededAuditShard,
  seedAuditFile,
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
  "refresh-unit-progress",
  "fold-unit-merge",
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
      expect(directStateTransition(`aidlc state ${verb} fixture`)).toBeNull();
      expect(directStateTransition(`/opt/aidlc/bin/aidlc engine state ${verb} fixture`))
        .toBe(verb);
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
      "echo aidlc state approve feasibility",
      "printf '%s' 'aidlc engine state reject feasibility'",
      "cat <<'EOF'\naidlc state advance feasibility\nEOF",
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
    for (const command of [
      "aidlc engine orchestrate report --stage feasibility --result completed",
      "aidlc engine state approve feasibility",
      "aidlc engine jump execute --target application-design",
      "/opt/aidlc/bin/aidlc engine orchestrate park",
    ]) {
      expect(isLifecycleBoundaryCommand(command), command).toBe(true);
    }
    expect(isLifecycleBoundaryCommand("echo aidlc report --result completed")).toBe(false);
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
        "bun .claude/tools/aidlc.ts intent archive other-intent --reason done",
        "aidlc.ts intent archive",
      ],
      [
        "bun .claude/tools/aidlc-utility.ts intent unarchive other-intent",
        "aidlc-utility.ts intent unarchive",
      ],
      ["aidlc intent archive other-intent", "aidlc intent archive"],
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
        "bun .claude/tools/aidlc.ts engine intent create --scope feature",
        "aidlc.ts engine intent create",
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
    expect(delegated.stderr).toContain(
      "only the main workflow session can change stage status or routing",
    );

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
        "only the main workflow session can change stage status or routing",
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

  test("runtime integrity refuses direct hook invocation and harness control assignments", () => {
    const env = unownedEnv();
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    for (const command of [
      `printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"chosen","prompt":"/aidlc --guard-policy off"}' | bun .claude/hooks/aidlc-record-human-turn.ts`,
      "bun .claude/tools/aidlc.ts engine hook record-human-turn",
      'bun ".claude/tools/aidlc.ts" engine hook record-human-turn',
      "aidlc engine hook record-human-turn",
      "AIDLC_INTERNAL_HUMAN_TURN_TOKEN=forged bun .claude/tools/aidlc.ts --internal-aidlc-record-human-turn .claude/hooks/aidlc-record-human-turn.ts",
      "bun .kiro/hooks/aidlc-kiro-adapter.ts record-human-turn",
      "bun .codex/hooks/aidlc-codex-adapter.ts record-human-turn",
      "bun .aidlc/hooks/aidlc-copilot-adapter.ts record-human-turn",
      "bun .cursor/hooks/aidlc-cursor-adapter.ts record-human-turn",
      "AIDLC_SESSION_OVERRIDE=abc bun .claude/tools/aidlc-utility.ts config-change --guard-policy off",
      "env AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 bun .claude/tools/aidlc-utility.ts config-change --guard-policy off",
      "export AIDLC_SESSION_OVERRIDE_SOURCE=hook",
      "AIDLC_UNATTENDED=0 bun .claude/tools/aidlc-utility.ts config-change --guard-policy off",
      "export AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS=1",
      "env AIDLC_STATE_TRANSITION_OWNER=orchestrate bun .claude/tools/aidlc-state.ts approve feasibility",
    ]) {
      const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        }),
        encoding: "utf-8",
        env,
      });
      expect(r.status, command).toBe(2);
      expect(r.stdout, command).toBe("");
      expect(r.stderr, command).toContain("AIDLC runtime records and hooks belong to the harness");
    }
  });

  test("runtime integrity refuses inline imports, dispatcher argv, command substitutions, aliases, functions, and heredocs", () => {
    // These payloads exercise module loading and dispatcher calls inside scripts.
    // A module name assembled from fragments at run time is outside this
    // lexical check's reach; the harness's permission model is the boundary there.
    for (const command of [
      `bun -e 'import("./.claude/hooks/aidlc-record-human-turn.ts")'`,
      `bun --eval 'await import("aidlc-guard-switch")'`,
      `node -e 'require("./.claude/tools/aidlc-guard-switch.ts")'`,
      `bun -e "Bun.spawnSync([process.execPath, '.claude/tools/aidlc.ts', 'engine', 'hook', 'record-human-turn'])"`,
      `python -c 'import subprocess; subprocess.run(["bun", ".claude/hooks/aidlc-record-human-turn.ts"])'`,
      `sh -c 'bun .claude/hooks/aidlc-record-human-turn.ts'`,
      `bash -c "$(printf '%s' 'bun .claude/hooks/aidlc-record-human-turn.ts')"`,
      `zsh -c "node -e 'require(\\"./.claude/tools/aidlc-guard-switch.ts\\")'"`,
      `alias h='bun .claude/hooks/aidlc-record-human-turn.ts'`,
      `alias h="bun -e 'import(\\"./.claude/tools/aidlc-guard-switch.ts\\")'"`,
      `function h { bun -e 'import("aidlc-guard-switch")'; }`,
      `h() { bun -e 'import("aidlc-guard-switch")'; }`,
      `bun <<'EOF'\nawait import("./.claude/hooks/aidlc-record-human-turn.ts")\nEOF`,
      `bun <<'EOF'\nBun.spawnSync([process.execPath, '.claude/tools/aidlc.ts', 'engine', 'hook', 'record-human-turn'])\nEOF`,
    ]) {
      const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        }),
        encoding: "utf-8",
        env: unownedEnv(),
      });
      expect(r.status, command).toBe(2);
      expect(r.stdout, command).toBe("");
    }
  });

  test("runtime integrity reads wrapper scripts at interpreter and executable positions", () => {
    const project = createTestProject();
    projects.push(project);
    writeFileSync(join(project, "wrapper.ts"), 'import "./.claude/tools/aidlc-guard-switch.ts";\n');
    writeFileSync(join(project, "wrapper"), 'bun .claude/hooks/aidlc-record-human-turn.ts\n');
    writeFileSync(join(project, "argv-wrapper.ts"), 'Bun.spawnSync([process.execPath, ".claude/tools/aidlc.ts",\n\t"engine"\n, `hook` ,\n\t"record-human-turn"\n]);\n');
    for (const command of [
      `bun "${join(project, "wrapper.ts")}"`,
      "node wrapper.ts",
      "bun run wrapper.ts",
      "tsx wrapper.ts",
      "./wrapper",
      "wrapper.ts",
      "bun argv-wrapper.ts",
    ]) {
      const r = spawnSync(process.execPath, [HOOK], {
        cwd: project,
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          cwd: project,
          tool_name: "Bash",
          tool_input: { command },
        }),
        encoding: "utf-8",
        env: unownedEnv(),
      });
      expect(r.status, command).toBe(2);
      expect(r.stdout, command).toBe("");
    }
  });

  test("runtime integrity bounds wrapper reads, ignores unavailable script files, and lets scripts mention hooks", () => {
    const project = createTestProject();
    projects.push(project);
    const content = 'import "./.claude/tools/aidlc-guard-switch.ts";\n';
    writeFileSync(join(project, "at-limit.ts"), content.padEnd(1024 * 1024, " "));
    writeFileSync(join(project, "over-limit.ts"), content.padEnd(1024 * 1024 + 1, " "));
    mkdirSync(join(project, "directory.ts"));
    writeFileSync(join(project, "mentions.ts"), '// aidlc-guard-switch and aidlc-record-human-turn are hooks\nconst names = ["aidlc-record-human-turn.ts", "engine hook"];\nconsole.log(names);\n');
    for (const [command, status] of [
      ["bun at-limit.ts", 2],
      ["bun mentions.ts", 0],
      ["bun over-limit.ts", 0],
      ["bun missing.ts", 0],
      ["bun directory.ts", 0],
    ] as const) {
      const r = spawnSync(process.execPath, [HOOK], {
        cwd: project,
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          cwd: project,
          tool_name: "Bash",
          tool_input: { command },
        }),
        encoding: "utf-8",
        env: unownedEnv(),
      });
      expect(r.status, command).toBe(status);
      if (status === 0) expect(r.stderr, command).toBe("");
    }
  });

  test("runtime integrity refuses shell mutations of session and Plan Approval records", () => {
    for (const command of [
      "echo x > aidlc/.aidlc-sessions/foo.json",
      "printf x | tee aidlc/.aidlc-sessions/foo.json",
      "cp f aidlc/.aidlc-sessions/.aidlc-plan-approval/override-s.json",
      "cp -t aidlc/.aidlc-sessions f",
      "mv aidlc/.aidlc-sessions/foo.json /tmp/moved.json",
      "mv f .aidlc-plan-approval/override-s.json",
      "rm -rf aidlc/.aidlc-sessions",
      "mkdir -p aidlc/.aidlc-sessions/.aidlc-plan-approval",
      "touch aidlc/.aidlc-sessions/presence-bypass-s",
      "sed -i 's/strict/off/' aidlc/.aidlc-sessions/foo.json",
      `python3 -c "open('aidlc/.aidlc-sessions/x','w')"`,
      `node -e "require('node:fs').writeFileSync('aidlc/.aidlc-sessions/x', 'x')"`,
      `bun -e "Bun.write('.aidlc-plan-approval/x', 'x')"`,
      `python -c "print('.aidlc-sessions')"`,
    ]) {
      const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        }),
        encoding: "utf-8",
        env: unownedEnv(),
      });
      expect(r.status, command).toBe(2);
      expect(r.stderr, command).toContain("AIDLC runtime records and hooks belong to the harness");
    }
  });

  test("runtime integrity refuses file-write tools before the Bash-only lifecycle check", () => {
    for (const [tool_name, tool_input] of [
      ["Write", { file_path: "aidlc/.aidlc-sessions/.aidlc-plan-approval/presence-bypass-s" }],
      ["Edit", { file_path: "aidlc/.aidlc-sessions/foo.json" }],
      ["MultiEdit", { edits: [{ file_path: "notes.md" }, { file_path: ".aidlc-plan-approval/override-s.json" }] }],
      ["NotebookEdit", { notebook_path: "aidlc/.aidlc-sessions/records.ipynb" }],
      ["Write", { file_path: String.raw`C:\project\aidlc\.aidlc-sessions\foo.json` }],
    ] as const) {
      const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }),
        encoding: "utf-8",
        env: unownedEnv(),
      });
      expect(r.status, tool_name).toBe(2);
      expect(r.stderr, tool_name).toContain("AIDLC runtime records and hooks belong to the harness");
    }
    const relativeWrite = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: "/tmp/aidlc/.aidlc-sessions",
        tool_name: "Write",
        tool_input: { file_path: "foo.json" },
      }),
      encoding: "utf-8",
      env: unownedEnv(),
    });
    expect(relativeWrite.status).toBe(2);
    expect(relativeWrite.stderr).toContain("AIDLC runtime records and hooks belong to the harness");
  });

  test("runtime integrity refuses written hook imports and dispatcher argv outside the runtime and authored repository", () => {
    const project = createTestProject();
    projects.push(project);
    const content = 'import { applyIntentSettings } from ".claude/tools/aidlc-guard-switch.ts"';
    for (const [tool_name, tool_input] of [
      ["Write", { file_path: "scripts/x.ts", content }],
      ["Write", { file_path: "scripts/x.ts", content: "Bun.spawnSync([process.execPath, '.claude/tools/aidlc.ts', 'engine', 'hook', 'record-human-turn'])" }],
      ["Edit", { file_path: "scripts/x.ts", new_string: content }],
      ["MultiEdit", { file_path: "scripts/x.ts", edits: [{ new_string: content }] }],
      ["MultiEdit", { edits: [{ file_path: ".claude/tools/x.ts", new_string: content }, { file_path: "scripts/x.ts", new_string: content }] }],
      ["NotebookEdit", { notebook_path: "analysis.ipynb", new_source: content }],
    ] as const) {
      const r = spawnSync(process.execPath, [HOOK], {
        cwd: project,
        input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: project, tool_name, tool_input }),
        encoding: "utf-8",
        env: unownedEnv(),
      });
      expect(r.status, JSON.stringify(tool_input)).toBe(2);
    }
  });

  test("runtime integrity allows inert dispatcher argv in project writes, inline code, and wrapper scripts", () => {
    const project = createTestProject();
    projects.push(project);
    const route = '"engine", "hook", "record-human-turn"';
    for (const content of [
      `const route = [${route}];`,
      `const config = { args: ["aidlc", ${route}] };`,
      `const fixture = [process.execPath, ".claude/tools/aidlc.ts", ${route}];`,
      `// Example route: [${route}]\nconst note = '[${route}]';`,
      `Bun.spawnSync(["echo", "ready"]); const route = [${route}];`,
      `const route = [${route}]; Bun.spawnSync(["echo", "ready"]);`,
      // Even process argv can be data: echo/printf do not execute these words.
      `Bun.spawnSync(["echo", "aidlc", ${route}]);`,
      `import { spawnSync } from "node:child_process"; spawnSync("echo", [${route}]);`,
      `import { execFileSync } from "node:child_process"; execFileSync("printf", ["%s", ${route}]);`,
    ]) {
      writeFileSync(join(project, "argv-data.ts"), content);
      for (const [tool_name, tool_input] of [
        ["Write", { file_path: "scripts/data.ts", content }],
        ["Edit", { file_path: "scripts/data.ts", new_string: content }],
        ["MultiEdit", { file_path: "scripts/data.ts", edits: [{ new_string: content }] }],
        ["NotebookEdit", { notebook_path: "analysis.ipynb", new_source: content }],
        ["Bash", { command: "bun argv-data.ts" }],
        ["Bash", { command: `bun -e '${content.replaceAll("'", "'\\''")}'` }],
        ["Bash", { command: `bun <<'EOF'\n${content}\nEOF` }],
      ] as const) {
        const r = spawnSync(process.execPath, [HOOK], {
          cwd: project,
          input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: project, tool_name, tool_input }),
          encoding: "utf-8",
          env: unownedEnv(),
        });
        expect(r.status, `${tool_name}: ${JSON.stringify(tool_input)}`).toBe(0);
        expect(r.stderr, content).toBe("");
      }
    }
  });

  test("runtime integrity does not treat eval, print, or check arguments as dispatcher scripts", () => {
    const project = createTestProject();
    projects.push(project);
    const route = '"engine", "hook", "record-human-turn"';
    for (const mode of ["-e", "--eval", "-p", "--print", "-c", "--check", "-pe", "-ie",
      "-e0", "--eval=0", "-p0", "--print=0", "-ie0"]) {
      for (const content of [
        `Bun.spawnSync(["bun", "${mode}", "aidlc.ts", ${route}]);`,
        `import { execFileSync } from "node:child_process"; execFileSync("node", ["${mode}", "aidlc.ts", ${route}]);`,
      ]) {
        for (const [tool_name, tool_input] of [
          ["Write", { file_path: "scripts/data.ts", content }],
          ["Bash", { command: `bun -e '${content}'` }],
        ] as const) {
          const r = spawnSync(process.execPath, [HOOK], {
            cwd: project,
            input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: project, tool_name, tool_input }),
            encoding: "utf-8",
            env: unownedEnv(),
          });
          expect(r.status, `${tool_name}: ${content}`).toBe(0);
          expect(r.stderr, content).toBe("");
        }
      }
    }
  });

  test("complete hook examples in comments, strings, regexes and document fixtures stay inert", () => {
    const project = createTestProject();
    projects.push(project);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const example of [
      'Bun.spawnSync([process.execPath, ".claude/tools/aidlc.ts", "engine", "hook", "record-human-turn"])',
      'execFileSync("aidlc", ["engine", "hook", "record-human-turn"])',
      'import("./.claude/hooks/aidlc-record-human-turn.ts")',
      'import { applyIntentSettings } from "./.claude/tools/aidlc-guard-switch.ts";',
      'require("./.claude/tools/aidlc-guard-switch.ts")',
      'execSync("bun .claude/hooks/aidlc-record-human-turn.ts")',
    ]) {
      const inert = `const example = ${JSON.stringify(example)};`;
      for (const content of [
        `// ${example}\nconsole.log("example");`,
        `/*\n${example}\n*/\nconsole.log("example");`,
        inert,
        `const fixture = { source: ${JSON.stringify(example)} };`,
        `/example/.exec(${JSON.stringify(example)});`,
        `const matcher = /example/; matcher.exec(${JSON.stringify(example)});`,
        `const text = \`${example}\`;`,
        `const text = \`\${${JSON.stringify(example)}}\`;`,
        `const pattern = /${example.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("/", "\\/")}/;`,
        `eval(${JSON.stringify(inert)});`,
        `new Function(${JSON.stringify(inert)})();`,
      ]) {
        writeFileSync(join(project, "literal-data.ts"), content);
        for (const [tool_name, tool_input] of [
          ["Write", { file_path: "scripts/example.ts", content }],
          ["Edit", { file_path: "scripts/example.ts", new_string: content }],
          ["MultiEdit", { edits: [{ file_path: "scripts/example.ts", new_string: content }] }],
          ["NotebookEdit", { notebook_path: "examples.ipynb", new_source: content }],
          ["Bash", { command: "bun literal-data.ts" }],
          ["Bash", { command: `bun -e ${quote(content)}` }],
          ["Bash", { command: `bun <<'EOF'\n${content}\nEOF` }],
          ["Bash", { command: `printf '%s' ${quote(content)}` }],
        ] as const) {
          expect(violatesRuntimeIntegrity({ cwd: project, tool_name, tool_input }),
            `${tool_name}: ${JSON.stringify(tool_input)}`).toBe(false);
        }
      }
      const document = `# Launcher examples\n\n\`\`\`ts\n${example}\n\`\`\`\n`;
      for (const content of [document, `Use ${example} as an example.`,
        `\`\`\`js\nconst result = \`\${${example}}\`;\n\`\`\``]) {
        expect(violatesRuntimeIntegrity({
          cwd: project, tool_name: "Write", tool_input: { file_path: "docs/examples.md", content },
        }), content).toBe(false);
      }
    }
  });

  test("executable hook use survives comments, code-evaluation sinks and template interpolation", () => {
    const project = createTestProject();
    projects.push(project);
    const launch = 'Bun.spawnSync([process.execPath, ".claude/tools/aidlc.ts", "engine", "hook", "record-human-turn"])';
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const content of [
      launch,
      'Bun /* receiver */ . spawnSync /* call */ ([process /* runtime */ . execPath, ".claude/tools/aidlc.ts", "engine", "hook", "record-human-turn"]);',
      'Bun["spawnSync"]({ cwd: ".", cmd: ["aidlc", "engine", "hook", "record-human-turn"] });',
      'import { spawnSync } from "node:child_process"; spawnSync("NODE.EXE", [".claude/tools/aidlc.ts", "engine", "hook", "record-human-turn"]);',
      'import /* module */ ("./.claude/hooks/aidlc-record-human-turn.ts");',
      'import { applyIntentSettings } /* binding */ from "./.claude/tools/aidlc-guard-switch.ts";',
      'require("\\x2e/.claude/tools/aidlc-guard-switch.ts");',
      `/* inert ${launch} */\n${launch};`,
      `// inert example\r${launch};`,
      `// inert example\u2028${launch};`,
      `// inert example\u2029${launch};`,
      `const example = ${JSON.stringify(launch)};\n${launch};`,
      `eval(${JSON.stringify(launch)});`,
      `const source = ${JSON.stringify(launch)}; eval(source);`,
      `const source = ${JSON.stringify(launch)}\reval(source);`,
      `const source = ${JSON.stringify(launch)}; new Function(source)();`,
      `const source = ${JSON.stringify(launch)}; Bun.spawnSync(["bun", "--eval", source]);`,
      'const argv = ["aidlc", "engine", "hook", "record-human-turn"]; Bun.spawnSync(argv);',
      `(0, eval)(${JSON.stringify(launch)});`,
      `eval.call(null, ${JSON.stringify(launch)});`,
      `eval.apply(null, [${JSON.stringify(launch)}]);`,
      `Function(${JSON.stringify(launch)})();`,
      `new Function("argument", ${JSON.stringify(launch)})(1);`,
      `Function.call(null, ${JSON.stringify(launch)})();`,
      `const text = \`\${${launch}}\`;`,
      `const text = \`\${(() => { return import("./.claude/hooks/aidlc-record-human-turn.ts"); })()}\`;`,
      `Bun.spawnSync(["bun", "--eval", ${JSON.stringify(launch)}]);`,
      `import { execFileSync } from "node:child_process"; execFileSync("node", ["-pe", ${JSON.stringify(launch)}]);`,
      'import * as child_process from "node:child_process"; child_process.execSync("bun .claude/hooks/aidlc-record-human-turn.ts");',
      'import * as child_process from "node:child_process"; child_process.exec("bun .claude/hooks/aidlc-record-human-turn.ts");',
    ]) {
      writeFileSync(join(project, "execute-example.ts"), content);
      for (const [tool_name, tool_input] of [
        ["Write", { file_path: "scripts/execute.ts", content }],
        ["Bash", { command: "bun execute-example.ts" }],
        ["Bash", { command: `bun -e ${quote(content)}` }],
        ["Bash", { command: `bun <<'EOF'\n${content}\nEOF` }],
      ] as const) {
        expect(violatesRuntimeIntegrity({ cwd: project, tool_name, tool_input }),
          `${tool_name}: ${JSON.stringify(tool_input)}`).toBe(true);
      }
    }
  });

  test("Edit and MultiEdit inspect the resulting syntax without mutating the target", () => {
    const project = createTestProject();
    projects.push(project);
    const file = join(project, "examples.ts");
    const launch = 'Bun.spawnSync(["aidlc", "engine", "hook", "record-human-turn"])';
    for (const [original, tool_name, tool_input, blocked] of [
      ["/* EXAMPLE */\n", "Edit", { file_path: file, old_string: "EXAMPLE", new_string: launch }, false],
      ["/* EXAMPLE */\n", "Edit", { file_path: "examples.ts", old_string: "EXAMPLE", new_string: launch }, false],
      ['const text = "EXAMPLE";\n', "Edit", {
        file_path: file, old_string: "EXAMPLE", new_string: launch.replaceAll('"', '\\"'),
      }, false],
      ["/* EXAMPLE */\n", "Edit", {
        file_path: file, old_string: "EXAMPLE", new_string: `*/\n${launch};\n/*`,
      }, true],
      [`/*\n${launch};\n*/\n`, "MultiEdit", { file_path: file, edits: [
        { old_string: "/*", new_string: "" },
        { old_string: "*/", new_string: "" },
      ] }, true],
      [`/*\n${launch};\n*/\n`, "MultiEdit", { edits: [
        { file_path: "./examples.ts", old_string: "/*", new_string: "" },
        { file_path: file, old_string: "*/", new_string: "" },
      ] }, true],
      [`/*\n${launch};\n*/\n`, "MultiEdit", { file_path: file, edits: [
        { old_string: "/*", new_string: "// example\n/*" },
        { old_string: "*/", new_string: "*/\n// end" },
      ] }, false],
    ] as const) {
      writeFileSync(file, original);
      expect(violatesRuntimeIntegrity({ cwd: project, tool_name, tool_input }), JSON.stringify(tool_input)).toBe(blocked);
      expect(readFileSync(file, "utf-8")).toBe(original);
    }
  });

  test("shell and Python execution contexts keep examples inert and actual nested execution protected", () => {
    const project = createTestProject();
    projects.push(project);
    const hook = "bun .claude/hooks/aidlc-record-human-turn.ts";
    const python = 'subprocess.run(["aidlc", "engine", "hook", "record-human-turn"])';
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const [command, blocked] of [
      [`# ${hook}\necho example`, false],
      [`printf '%s' ${quote(hook)}`, false],
      [`sh -c ${quote(`printf '%s' ${quote(hook)}`)}`, false],
      [`python -c ${quote(`# ${python}\nprint("example")`)}`, false],
      [`python -c ${quote(`sample = ${JSON.stringify(python)}\nprint(sample)`)}`, false],
      [`python -c ${quote(`"""${python}"""\nprint("example")`)}`, false],
      [`python -c ${quote(`import subprocess; ${python}`)}`, true],
      [`python -c ${quote(`exec(${JSON.stringify(`import subprocess; ${python}`)})`)}`, true],
      [`echo "$(${hook})"`, true],
      [`echo \`${hook}\``, true],
      [`bash -c "$(printf '%s' ${quote(hook)})"`, true],
      [`sh -c ${quote(`eval ${quote(hook)}`)}`, true],
      [`cat <<EOF\nconst text = "$(${hook})";\nEOF`, true],
      [`cat <<'EOF'\nconst text = "$(${hook})";\nEOF`, false],
    ] as const) {
      expect(violatesRuntimeIntegrity({ cwd: project, tool_name: "Bash", tool_input: { command } }), command).toBe(blocked);
    }
    for (const [file, content, blocked] of [
      ["example.sh", `# ${hook}\nprintf '%s' ${quote(hook)}\n`, false],
      ["example.py", `# ${python}\nsample = ${JSON.stringify(python)}\n`, false],
      ["execute.sh", `${hook}\n`, true],
      ["execute.py", `import subprocess\n${python}\n`, true],
    ] as const) {
      writeFileSync(join(project, file), content);
      expect(violatesRuntimeIntegrity({
        cwd: project, tool_name: "Write", tool_input: { file_path: file, content },
      }), file).toBe(blocked);
      expect(violatesRuntimeIntegrity({
        cwd: project, tool_name: "Bash", tool_input: { command: `${file.endsWith(".py") ? "python" : "sh"} ${file}` },
      }), file).toBe(blocked);
    }
  });

  test("heredoc bodies are data unless consumed as source or written to a script", () => {
    const project = createTestProject();
    projects.push(project);
    const launch = 'Bun.spawnSync(["aidlc", "engine", "hook", "record-human-turn"]);';
    const hook = "bun .claude/hooks/aidlc-record-human-turn.ts";
    const python = 'import subprocess\nsubprocess.run(["aidlc", "engine", "hook", "record-human-turn"])';
    for (const [header, body, blocked] of [
      ["cat <<'EOF'", launch, false],
      ["cat >docs.md <<'EOF'", launch, false],
      ["cat <<'EOF' >docs.md", launch, false],
      ["cat <<'EOF' | tee docs.md", launch, false],
      ["bun --version; cat <<'EOF'", launch, false],
      ["cat <<'EOF'; bun --version", launch, false],
      ["node app.js <<'EOF'", launch, false],
      ["python app.py <<'EOF'", python, false],
      ["sh app.sh <<'EOF'", hook, false],
      ["node -e 'console.log(0)' <<'EOF'", launch, false],
      ["node --check <<'EOF'", launch, false],
      ["bun <<'EOF'", launch, true],
      ["node - <<'EOF'", launch, true],
      ["node /dev/stdin <<'EOF'", launch, true],
      ["node >output.log <<'EOF'", launch, true],
      ["node <<'EOF' >output.log", launch, true],
      ["node 0<<'EOF'", launch, true],
      ["node 3<<'EOF'", launch, false],
      ["cat <<'EOF' | bun", launch, true],
      ["python <<'EOF'", python, true],
      ["sh <<'EOF'", hook, true],
      ["sh -s <<'EOF'", hook, true],
      ["cat >wrapper.ts <<'EOF'", launch, true],
      ["cat <<'EOF' >wrapper.py", python, true],
      ["tee wrapper.sh <<'EOF'", hook, true],
      ["cat <<EOF", `const text = "$(${hook})";`, true],
      ["cat >docs.md <<EOF", `const text = "$(${hook})";`, true],
      ["cat >.aidlc-plan-approval/example.md <<'EOF'", launch, true],
      ["cat <<'EOF'", `const text = "$(${hook})";`, false],
    ] as const) {
      const command = `${header}\n${body}\nEOF`;
      expect(violatesRuntimeIntegrity({ cwd: project, tool_name: "Bash", tool_input: { command } }), command).toBe(blocked);
    }
    const file = join(project, "example.md");
    writeFileSync(file, launch);
    expect(violatesRuntimeIntegrity({
      cwd: project, tool_name: "Bash", tool_input: { command: "bun example.md" },
    })).toBe(true);
    expect(violatesRuntimeIntegrity({
      cwd: project, tool_name: "NotebookEdit", tool_input: { notebook_path: file, new_source: launch },
    })).toBe(true);
    expect(violatesRuntimeIntegrity({
      cwd: project, tool_name: "Write", tool_input: { file_path: ".aidlc-plan-approval/example.md", content: launch },
    })).toBe(true);
  });

  test("loader and preload options execute modules while cwd and condition values remain data", () => {
    const project = createTestProject();
    projects.push(project);
    const module = "./.claude/hooks/aidlc-record-human-turn.ts";
    writeFileSync(join(project, "loader.mjs"), `import ${JSON.stringify(module)};`);
    for (const [command, blocked] of [
      [`node --loader ${module} app.js`, true],
      [`node --loader=${module} app.js`, true],
      [`node --experimental-loader ${module} app.js`, true],
      [`node --import ${module} app.js`, true],
      [`node --require=${module} app.js`, true],
      [`node -r${module} app.js`, true],
      [`node --eval '0' --loader ${module}`, true],
      ["node --loader ./loader.mjs app.js", true],
      [`bun --cwd ${module} app.ts`, false],
      [`node --conditions ${module} app.js`, false],
      [`node --conditions=${module} app.js`, false],
      [`bun --config ${module} app.ts`, false],
    ] as const) {
      expect(violatesRuntimeIntegrity({
        cwd: project, tool_name: "Bash", tool_input: { command },
      }), command).toBe(blocked);
    }
    for (const [content, blocked] of [
      [`Bun.spawnSync(["node", "--loader", ${JSON.stringify(module)}, "app.js"]);`, true],
      [`Bun.spawnSync(["node", "--loader=${module}", "app.js"]);`, true],
      [`Bun.spawnSync(["bun", "--cwd", ${JSON.stringify(module)}, "app.ts"]);`, false],
      [`// node --loader ${module}\nconst example = "node --loader ${module}";`, false],
    ] as const) {
      expect(violatesRuntimeIntegrity({
        cwd: project, tool_name: "Write", tool_input: { file_path: "example.ts", content },
      }), content).toBe(blocked);
    }
  });

  test("runtime integrity still refuses dispatcher argv in process execution calls", () => {
    const project = createTestProject();
    projects.push(project);
    const route = '"engine", "hook", "record-human-turn"';
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    for (const [language, content] of [
      ["js", `Bun.spawnSync([process.execPath, ".claude/tools/aidlc.ts", ${route}]);`],
      ["js", `Bun.spawn({ cmd: ["aidlc", ${route}], stdout: "pipe" });`],
      ["js", `Bun.spawnSync(["bun", "--silent", "run", ".claude/tools/aidlc.ts", ${route}]);`],
      ["js", `import { spawnSync } from "node:child_process"; spawnSync("aidlc", [${route}]);`],
      ["js", `import * as child_process from "node:child_process"; child_process.spawn("/opt/bin/aidlc", [${route}]);`],
      ["js", `import { execFileSync } from "node:child_process"; execFileSync(process.execPath, [".claude/tools/aidlc.ts", ${route}]);`],
      ["js", `import { execFile } from "node:child_process"; execFile("node", ["--no-warnings", ".claude/tools/aidlc.ts", ${route}]);`],
      ["py", `import subprocess\nsubprocess.run(["aidlc", ${route}], check=True)`],
      ["py", `import subprocess\nsubprocess.Popen(["bun", "run", ".claude/tools/aidlc.ts", ${route}])`],
      ["js", `Bun.spawnSync(["bun", "--eval", \`import("aidlc-guard-switch")\`]);`],
      ["js", `import { execFileSync } from "node:child_process"; execFileSync("node", ["--print", \`require("aidlc-guard-switch")\`]);`],
      ["js", `Bun.spawnSync(["bun", "--eval", \`Bun.spawnSync(["aidlc", ${route}])\`]);`],
    ] as const) {
      const filename = `argv-execution.${language === "py" ? "py" : "ts"}`;
      const runtime = language === "py" ? "python" : "bun";
      const inline = `${runtime} ${language === "py" ? "-c" : "-e"} ${quote(content)}`;
      writeFileSync(join(project, filename), content);
      for (const [tool_name, tool_input] of [
        ["Write", { file_path: filename, content }],
        ["Bash", { command: `${runtime} ${filename}` }],
        ["Bash", { command: inline }],
        ["Bash", { command: `bash -lc ${quote(inline)}` }],
      ] as const) {
        const r = spawnSync(process.execPath, [HOOK], {
          cwd: project,
          input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: project, tool_name, tool_input }),
          encoding: "utf-8",
          env: unownedEnv(),
        });
        expect(r.status, `${tool_name}: ${JSON.stringify(tool_input)}`).toBe(2);
        expect(r.stderr, content).toContain("AIDLC runtime records and hooks belong to the harness");
      }
    }
  });

  test("execution API provenance distinguishes custom receivers from real imported functions and aliases", () => {
    const project = createTestProject();
    projects.push(project);
    const command = '"bun .claude/hooks/aidlc-record-human-turn.ts"';
    const argv = '["aidlc", "engine", "hook", "record-human-turn"]';
    const source = `Bun.spawnSync(${argv})`;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const [language, content, blocked] of [
      ["js", `const mock = { exec: x => x }; mock.exec(${command});`, false],
      ["js", `const parser = { spawn: x => x }; parser.spawn(${argv});`, false],
      ["js", `const app = { system: x => x }; app.system(${command});`, false],
      ["js", `class Command { constructor(cmd, opts) {} } new Command("aidlc", {args: ${argv}.slice(1)});`, false],
      ["js", `const ownCommand = (cmd, args) => args; ownCommand("aidlc", ${argv});`, false],
      ["js", `const app = { Command: class {} }; new app.Command("aidlc", {args: ${argv}});`, false],
      ["js", `const mock = { eval: x => x, Function: x => x }; mock.eval(${JSON.stringify(source)}); mock.Function(${JSON.stringify(source)});`, false],
      ["js", 'const mock = { require: x => x, import: x => x }; mock.require("aidlc-guard-switch"); mock.import("aidlc-guard-switch");', false],
      ["js", `const parser = { runInThisContext: x => x }; parser.runInThisContext(${JSON.stringify(source)});`, false],
      ["js", `import { exec } from "./mock.ts"; exec(${command});`, false],
      ["js", `const mock = require("./mock.cjs"); mock.exec(${command});`, false],
      ["js", `import * as cp from "node:child_process"; cp.exec(${command});`, true],
      ["js", `import cp from "child_process"; cp.spawn("aidlc", ["engine", "hook", "record-human-turn"]);`, true],
      ["js", `import { exec as execute } from "node:child_process"; execute(${command});`, true],
      ["js", `import { exec as execute }\nfrom "node:child_process"\nexecute(${command});`, true],
      ["js", `const cp = require("node:child_process"); const api = cp; api.execSync(${command});`, true],
      ["js", `const { exec: execute } = require("child_process"); execute(${command});`, true],
      ["js", `const cp = require("child_process"); const execute = cp.exec; execute(${command});`, true],
      ["js", `const cp = require("child_process"); const execute = cp.exec.bind(cp); execute(${command});`, true],
      ["js", `require("node:child_process").exec(${command});`, true],
      ["js", `const cp = await import("node:child_process"); cp.exec(${command});`, true],
      ["js", `import { createRequire } from "node:module"; const load = createRequire(import.meta.url); const cp = load("node:child_process"); cp.exec(${command});`, true],
      ["js", `import vm from "node:vm"; vm.runInNewContext(${JSON.stringify(source)});`, true],
      ["js", `import { Script as Program } from "vm"; new Program(${JSON.stringify(source)});`, true],
      ["js", `const { runInThisContext: execute } = require("vm"); execute(${JSON.stringify(source)});`, true],
      ["js", 'import {execPath as runtime} from "node:process"; import {spawnSync as launch} from "node:child_process"; launch(runtime, [".claude/tools/aidlc.ts", "engine", "hook", "record-human-turn"]);', true],
      ["js", `const runtime = Bun; const launch = runtime.spawnSync; launch(${argv});`, true],
      ["js", 'new Deno.Command("aidlc", {args: ["engine", "hook", "record-human-turn"]});', true],
      ["js", `const execute = eval; execute(${JSON.stringify(source)});`, true],
      ["js", `const Factory = Function; Factory(${JSON.stringify(source)})();`, true],
      ["py", `from custom import system\nsystem(${command})`, false],
      ["py", `import mock\nmock.exec(${command})`, false],
      ["py", `import parser\nparser.spawn(${argv})`, false],
      ["py", `import subprocess as sp\nsp.run(${argv})`, true],
      ["py", `from subprocess import run as launch\nlaunch(${argv})`, true],
      ["py", `import os as host\nhost.system(${command})`, true],
      ["py", `from os import system as execute\nexecute(${command})`, true],
      ["py", `__import__("subprocess").run(${argv})`, true],
      ["py", `import builtins as builtin\nbuiltin.exec(${JSON.stringify(`import subprocess\nsubprocess.run(${argv})`)})`, true],
      ["py", `from builtins import exec as execute\nexecute(${JSON.stringify(`import os\nos.system(${command})`)})`, true],
    ] as const) {
      const file = `api-source.${language === "py" ? "py" : "ts"}`;
      writeFileSync(join(project, file), content);
      for (const [tool_name, tool_input] of [
        ["Write", { file_path: file, content }],
        ["Bash", { command: `${language === "py" ? "python" : "bun"} ${file}` }],
        ["Bash", { command: `${language === "py" ? "python -c" : "bun -e"} ${quote(content)}` }],
      ] as const) {
        expect(violatesRuntimeIntegrity({ cwd: project, tool_name, tool_input }),
          `${tool_name}: ${content}`).toBe(blocked);
      }
    }
  });

  test("API shadowing is scoped and does not erase genuine outer or captured execution bindings", () => {
    const project = createTestProject();
    projects.push(project);
    const command = '"bun .claude/hooks/aidlc-record-human-turn.ts"';
    const argv = '["aidlc", "engine", "hook", "record-human-turn"]';
    const source = `Bun.spawnSync(${argv})`;
    for (const [language, content, blocked] of [
      ["js", `const Bun = {spawnSync: x => x}; Bun.spawnSync(${argv});`, false],
      ["js", `const Deno = {Command: class {}}; new Deno.Command("aidlc", {args: ${argv}});`, false],
      ["js", `const eval = x => x; eval(${JSON.stringify(source)});`, false],
      ["js", `function Function(code) { return code; } Function(${JSON.stringify(source)});`, false],
      ["js", `const require = x => ({exec: x => x}); require("child_process").exec(${command});`, false],
      ["js", `function mock(Bun) { Bun.spawnSync(${argv}); }`, false],
      ["js", `const mock = (Bun) => Bun.spawnSync(${argv});`, false],
      ["js", `const mock = { run(Bun) { return Bun.spawnSync(${argv}); } };`, false],
      ["js", `function mock(eval) { eval(${JSON.stringify(source)}); }`, false],
      ["js", `Function("Bun", ${JSON.stringify(source)})({spawnSync: x => x});`, false],
      ["js", `const Bun = {spawnSync: x => x}; eval(${JSON.stringify(source)});`, false],
      ["js", `const Bun = {spawnSync: x => x}; const execute = eval; execute(${JSON.stringify(source)});`, true],
      ["js", `function mock(Bun) { Bun.spawnSync(${argv}); } Bun.spawnSync(${argv});`, true],
      ["js", `{ const Bun = {spawnSync: x => x}; Bun.spawnSync(${argv}); } Bun.spawnSync(${argv});`, true],
      ["js", `import * as cp from "child_process"; { const cp = {exec: x => x}; cp.exec(${command}); }`, false],
      ["js", `import {exec as run} from "child_process"; function mock(run) { run(${command}); }`, false],
      ["js", `import {exec as run} from "child_process"; function mock(run) { run(${command}); } run(${command});`, true],
      ["js", `let cp = require("child_process"); cp = {exec: x => x}; cp.exec(${command});`, false],
      ["js", `const cp = require("child_process"); cp.exec = x => x; cp.exec(${command});`, false],
      ["js", `const cp = require("child_process"); const alias = cp; cp.exec = x => x; alias.exec(${command});`, false],
      ["js", `const cp = require("child_process"); const run = cp.exec; cp.exec = x => x; run(${command});`, true],
      ["js", `import * as cp from "child_process"; export function run() { cp.exec(${command}); }`, true],
      ["py", `import subprocess\nsubprocess = mock\nsubprocess.run(${argv})`, false],
      ["py", `import subprocess\ndef mock(subprocess):\n    subprocess.run(${argv})`, false],
      ["py", `import os\ndef mock(os): os.system(${command})`, false],
      ["py", `def exec(source): return source\nexec(${JSON.stringify(source)})`, false],
      ["py", `def mock(eval): eval(${JSON.stringify(source)})`, false],
      ["py", `import subprocess\ndef mock(subprocess):\n    subprocess.run(${argv})\nsubprocess.run(${argv})`, true],
      ["py", `from os import system as execute\ndef mock(execute): execute(${command})\nexecute(${command})`, true],
    ] as const) {
      expect(violatesRuntimeIntegrity({
        cwd: project, tool_name: "Write",
        tool_input: { file_path: `shadow.${language === "py" ? "py" : "ts"}`, content },
      }), content).toBe(blocked);
    }
  });

  test("runtime integrity permits official entrypoints and authored development, not arbitrary installed launchers", () => {
    const project = createTestProject();
    projects.push(project);
    mkdirSync(join(project, "scripts"), { recursive: true });
    mkdirSync(join(project, ".claude", "tools"), { recursive: true });
    writeFileSync(join(project, "scripts", "package.ts"), "export {};\n");
    writeFileSync(join(project, "scripts", "build.ts"), 'console.log("build");\n');
    for (const tool of ["aidlc.ts", "aidlc-utility.ts"]) {
      writeFileSync(join(project, ".claude", "tools", tool), 'import "./aidlc-guard-switch.ts";\n');
    }
    const content = 'import "./.claude/tools/aidlc-guard-switch.ts";';
    for (const [tool_name, tool_input, status] of [
      ["Bash", { command: "bun .claude/tools/aidlc.ts engine orchestrate next" }, 0],
      ["Bash", { command: "bun .claude/tools/aidlc-utility.ts config-change --guard-policy strict" }, 0],
      ["Bash", { command: "bun scripts/build.ts" }, 0],
      ["Write", { file_path: "docs/notes.md", content }, 0],
      ["Write", { file_path: "docs/helper.ts", content }, 0],
      ["Write", { file_path: "core/hooks/helper.ts", content }, 0],
      ["Write", { file_path: "harness/adapter.ts", content }, 0],
      ["Write", { file_path: "tests/example.test.ts", content }, 0],
      ["Write", { file_path: ".claude/tools/helper.ts", content }, 2],
      ["Write", { file_path: ".claude/tools/helper.ts", content: "export const value = 1;" }, 0],
      ["MultiEdit", { edits: [{ file_path: ".claude/tools/helper.ts", new_string: content }, { file_path: "scripts/build.ts", new_string: 'console.log("build");' }] }, 2],
      ["Write", { file_path: "scripts/x.ts", content }, 2],
      ["Write", { file_path: "docs-extra/notes.md", content }, 0],
      ["Write", { file_path: "docs-extra/helper.ts", content }, 2],
      ["Write", { file_path: "docs/../scripts/x.ts", content }, 2],
      ["Write", { file_path: ".claude-extra/tools/helper.ts", content }, 2],
      ["Write", { file_path: "docs/.aidlc-sessions/foo.json", content }, 2],
    ] as const) {
      const r = spawnSync(process.execPath, [HOOK], {
        cwd: project,
        input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: project, tool_name, tool_input }),
        encoding: "utf-8",
        env: { ...unownedEnv(), AIDLC_HARNESS_DIR: ".claude" },
      });
      expect(r.status, JSON.stringify(tool_input)).toBe(status);
      if (status === 0) expect(r.stderr, JSON.stringify(tool_input)).toBe("");
    }
  });

  test("installed enforcement targets cannot be replaced with benign content through write tools", () => {
    const project = createTestProject();
    projects.push(project);
    const content = "export const run = async () => 0;\n";
    for (const path of [
      ".claude/hooks/aidlc-state-transition-guard.ts",
      ".claude/hooks/runtime-integrity.ts",
      ".codex/hooks/aidlc-codex-adapter.ts",
      ".kiro/hooks/aidlc-kiro-adapter.ts",
      ".cursor/hooks/aidlc-cursor-adapter.ts",
      ".aidlc/hooks/aidlc-copilot-adapter.ts",
      ".opencode/plugin/aidlc-opencode-adapter.ts",
      ".claude/tools/aidlc.ts",
      ".claude/tools/aidlc-lib.ts",
      ".claude/tools/aidlc-guard-switch.ts",
      ".claude/tools/aidlc-testing-posture.ts",
      ".claude/settings.json",
      ".codex/hooks.json",
      ".kiro/agents/aidlc.json",
      ".github/hooks/aidlc.json",
    ]) {
      for (const [tool_name, tool_input] of [
        ["Write", { file_path: path, content }],
        ["Edit", { file_path: path, old_string: "guard", new_string: content }],
        ["MultiEdit", { edits: [{ path, old_string: "guard", new_string: content }] }],
        ["NotebookEdit", { notebook_path: path, new_source: content }],
      ] as const) {
        expect(violatesRuntimeIntegrity({ cwd: project, tool_name, tool_input }), `${tool_name}: ${path}`).toBe(true);
      }
    }
    mkdirSync(join(project, ".claude", "hooks"), { recursive: true });
    symlinkSync(join(project, ".claude", "hooks"), join(project, "hook-alias"), process.platform === "win32" ? "junction" : "dir");
    expect(violatesRuntimeIntegrity({
      cwd: project, tool_name: "Write", tool_input: { file_path: "hook-alias/new-guard.ts", content },
    })).toBe(true);
  });

  test("recognized shell mutations protect installed enforcement files and their containing directories", () => {
    const project = createTestProject();
    projects.push(project);
    const hook = ".claude/hooks/aidlc-state-transition-guard.ts";
    mkdirSync(join(project, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(project, "noop.ts"), "export const run = () => 0;\n");
    for (const [command, blocked] of [
      [`printf 'export const run = () => 0' > ${hook}`, true],
      [`cp noop.ts ${hook}`, true],
      [`mv ${hook} saved.ts`, true],
      ["rm -rf .claude/hooks", true],
      ["rm -rf .claude", true],
      ["rm -rf .", true],
      ["rm -rf .opencode/plugin", true],
      [`sed -i 's/refuse/allow/g' ${hook}`, true],
      ["printf x | tee .claude/tools/aidlc-lib.ts", true],
      ["cp noop.ts .", false],
      ["rm scratch.txt", false],
      ["printf x > core/hooks/aidlc-state-transition-guard.ts", false],
      ["printf '{}' > .claude/tools/data/scope-grid.json", false],
    ] as const) {
      expect(violatesRuntimeIntegrity({
        cwd: project, tool_name: "Bash", tool_input: { command },
      }), command).toBe(blocked);
    }
  });

  test("new harness-directory launchers are inspected while ordinary customization remains writable", () => {
    const project = createTestProject();
    projects.push(project);
    const content = 'import "./.claude/tools/aidlc-guard-switch.ts";\n';
    mkdirSync(join(project, ".claude", "tools"), { recursive: true });
    for (const path of [".claude/launcher.ts", ".claude/tools/helper.ts", ".claude/tools/aidlc-new-launcher.ts"]) {
      writeFileSync(join(project, path), content);
      expect(violatesRuntimeIntegrity({
        cwd: project, tool_name: "Write", tool_input: { file_path: path, content },
      }), path).toBe(true);
      expect(violatesRuntimeIntegrity({
        cwd: project, tool_name: "Bash", tool_input: { command: `bun ${path}` },
      }), path).toBe(true);
    }
    for (const [path, text] of [
      [".claude/scopes/aidlc-custom.md", "# Custom scope\n"],
      [".claude/tools/data/scope-grid.json", "{}\n"],
      [".claude/tools/helper.ts", "export const value = 1;\n"],
    ]) {
      expect(violatesRuntimeIntegrity({
        cwd: project, tool_name: "Write", tool_input: { file_path: path, content: text },
      }), path).toBe(false);
    }
  });

  test("real engine and maintenance help commands remain runnable without rewriting installed files", () => {
    const project = createTestProject();
    projects.push(project);
    const dispatcher = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc.ts");
    for (const args of [["engine", "status"], ["config", "--help"], ["update", "--help"]]) {
      const command = `bun "${dispatcher}" ${args.join(" ")}`;
      expect(violatesRuntimeIntegrity({
        cwd: project, tool_name: "Bash", tool_input: { command },
      }), command).toBe(false);
      const result = spawnSync(process.execPath, [dispatcher, ...args], {
        cwd: project, encoding: "utf-8",
        env: { ...unownedEnv(), CLAUDE_PROJECT_DIR: project, AIDLC_PROJECT_DIR: project },
      });
      expect(result.status, `${command}\n${result.stderr}`).toBe(0);
      expect(result.stdout.trim().length, command).toBeGreaterThan(0);
    }
  });

  test("runtime integrity allows engine commands, conductor records, and ordinary documents", () => {
    const project = createTestProject();
    projects.push(project);
    for (const [tool_name, tool_input] of [
      ["Bash", { command: "bun .claude/tools/aidlc.ts engine orchestrate next" }],
      ["Bash", { command: "bun .claude/tools/aidlc-utility.ts config-change --guard-policy strict" }],
      ["Bash", { command: "echo > aidlc/.aidlc-compose-pending" }],
      ["Bash", { command: "git status" }],
      ["Bash", { command: "cat aidlc/.aidlc-sessions/foo.json" }],
      ["Bash", { command: "cp aidlc/.aidlc-sessions/foo.json /tmp/copy.json" }],
      ["Bash", { command: "echo x > aidlc/.aidlc-sessions-backup/foo.json" }],
      ["Bash", { command: "aidlc_session_override=abc git status" }],
      ["Write", { file_path: "aidlc/spaces/default/intents/x/.aidlc-engine/reviewer-dispatch.json" }],
      ["Edit", { file_path: "aidlc/spaces/default/intents/x/inception/requirements.md" }],
      ["MultiEdit", { edits: [{ file_path: "aidlc/spaces/default/intents/x/inception/requirements.md" }] }],
      ["NotebookEdit", { notebook_path: "aidlc/analysis.ipynb" }],
      // Prose that names a hook, a helper, or the engine hook route is ordinary
      // project content; only a concrete import or execution is a reference.
      ["Write", { file_path: "docs/notes.md", content: "The applyIntentSettings helper and the engine hook route are for hooks; see .claude/hooks/aidlc-record-human-turn.ts and aidlc-guard-switch.ts." }],
      ["Edit", { file_path: "src/notes.ts", new_string: 'const hooks = ["aidlc-record-human-turn", "aidlc-guard-switch"]; // engine hook names' }],
      ["Write", { file_path: "scripts/x.ts", content: 'const route = "engine hook record-human-turn"; // The engine hook route records a human turn.' }],
      ["Bash", { command: "echo 'engine hook' > notes.md" }],
      ["Bash", { command: `bun -e 'console.log("aidlc-guard-switch")'` }],
      ["Bash", { command: `bun -e 'console.log("engine hook record-human-turn")'` }],
      ["Bash", { command: `cat <<'EOF'\nThe engine hook route uses record-human-turn.\nEOF` }],
      ["Bash", { command: `python -c 'print("aidlc-record-human-turn")'` }],
      ["Bash", { command: "alias h='echo aidlc-record-human-turn'" }],
    ] as const) {
      const r = spawnSync(process.execPath, [HOOK], {
        cwd: project,
        input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: project, tool_name, tool_input }),
        encoding: "utf-8",
        env: unownedEnv(),
      });
      expect(r.status, JSON.stringify(tool_input)).toBe(0);
      expect(r.stderr, JSON.stringify(tool_input)).toBe("");
    }
  });

  test("runtime integrity stays enforced with state-transition off and the presence bypass", () => {
    const project = createTestProject();
    projects.push(project);
    seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const statePath = seededStateFile(project);
    const state = readFileSync(statePath, "utf-8");
    const env: NodeJS.ProcessEnv = { ...unownedEnv(), CLAUDE_PROJECT_DIR: project };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    for (const mode of ["fence-off", "presence-bypass"] as const) {
      writeFileSync(statePath, mode === "fence-off"
        ? state.replace("## Scope Configuration\n", "## Scope Configuration\n- **Guards Off**: state-transition (set by you)\n")
        : state);
      for (const [tool_name, tool_input] of [
        ["Bash", { command: "bun .claude/hooks/aidlc-record-human-turn.ts" }],
        ["Write", { file_path: "aidlc/.aidlc-sessions/presence-bypass-s" }],
        ["Write", { file_path: ".claude/hooks/aidlc-state-transition-guard.ts", content: "process.exit(0);" }],
      ] as const) {
        const r = spawnSync(process.execPath, [HOOK], {
          input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }),
          encoding: "utf-8",
          env: mode === "presence-bypass" ? { ...env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" } : env,
        });
        expect(r.status, `${mode}: ${tool_name}`).toBe(2);
        expect(r.stderr, mode).toContain("AIDLC runtime records and hooks belong to the harness");
      }
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
      "Stage status cannot be changed with aidlc-state.ts gate-start",
    );
    expect(r.stderr).toContain("aidlc-orchestrate.ts report");
  });

  test("direct state-tool refusals offer the switch only to the main session", () => {
    const project = createTestProject();
    projects.push(project);
    seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun .claude/tools/aidlc-state.ts gate-start feasibility" },
    };
    const env = { ...unownedEnv(), CLAUDE_PROJECT_DIR: project };
    const main = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env,
    });
    expect(main.status).toBe(2);
    expect(main.stderr).toContain("aidlc-orchestrate.ts report");
    expect(main.stderr).toContain("config set guard.state-transition off");
    const delegated = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ ...payload, agent_type: "aidlc-developer-agent" }),
      encoding: "utf-8",
      env,
    });
    expect(delegated.status).toBe(2);
    expect(delegated.stderr).toContain("aidlc-orchestrate.ts report");
    expect(delegated.stderr).not.toContain("config set guard.state-transition off");
    expect(delegated.stderr).not.toContain("cannot be turned off from chat");
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
        `Stage status cannot be changed with aidlc-state.ts ${verb}`,
      );
    }
  });

  test("the state CLI honors a lowered state-transition fence without corrupting JSON stdout", () => {
    const project = createTestProject();
    projects.push(project);
    seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
    seedAuditFile(project);
    const statePath = seededStateFile(project);
    const state = readFileSync(statePath, "utf-8");
    writeFileSync(
      statePath,
      state.replace(
        "## Scope Configuration\n",
        "## Scope Configuration\n- **Guards Off**: state-transition (set by you)\n",
      ),
    );
    const r = spawnSync(
      process.execPath,
      [STATE, "checkbox", "scope-definition=in-progress", "--project-dir", project],
      {
        encoding: "utf-8",
        env: { ...unownedEnv(), AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "0" },
      },
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout).updated).toBe(true);
    expect(r.stderr).toContain(
      "Continuing past the state-transition check because it is off for this piece of work (set by you)",
    );
    expect(readFileSync(statePath, "utf-8")).toContain("- [-] scope-definition");
    const rows = readFileSync(seededAuditShard(project), "utf-8")
      .split("\n## ")
      .filter((row) => row.includes("**Event**: GUARD_STOOD_ASIDE"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("**Guard**: state-transition");
    expect(rows[0]).toContain("**Tool**: aidlc-state.ts");
    expect(rows[0]).toContain("**Details**: aidlc-state.ts checkbox");
  });

  test("the state CLI refuses direct transitions when the state-transition fence is not lowered", () => {
    const project = createTestProject();
    projects.push(project);
    seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
    seedAuditFile(project);
    const statePath = seededStateFile(project);
    const before = readFileSync(statePath, "utf-8");
    const r = spawnSync(
      process.execPath,
      [STATE, "checkbox", "scope-definition=in-progress", "--project-dir", project],
      {
        encoding: "utf-8",
        env: { ...unownedEnv(), AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "0" },
      },
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("Stage status cannot be changed");
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(readFileSync(seededAuditShard(project), "utf-8")).not.toContain(
      "**Event**: GUARD_STOOD_ASIDE",
    );
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
      "Stage status cannot be changed with aidlc-state.ts gate-start",
    );
  });

  test("report propagates parent-bound ownership with both caller ownership vars cleared", () => {
    const project = createTestProject();
    projects.push(project);
    seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const env = unownedEnv();
    env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
    env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = "1";
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

  test("non-initialization stages delegate lifecycle transitions and Learn writes through the conditional module", () => {
    expect(NON_INITIALIZATION_STAGES).toHaveLength(30);
    for (const path of NON_INITIALIZATION_STAGES) {
      const body = readFileSync(path, "utf-8");
      const label = relative(REPO_ROOT, path);
      const slug = basename(path, ".md");

      expect(body, label).toMatch(
        new RegExp(
          String.raw`(?:aidlc-orchestrate\.ts|engine orchestrate) report\s+--stage\s+${slug}\b`,
        ),
      );
      expect(body, label).not.toMatch(DIRECT_LIFECYCLE_VERB);
      expect(body, label).not.toMatch(DIRECT_CHECKBOX_COMPLETION);
      expect(body, label).not.toMatch(DIRECT_STATE_HEADING);
      expect(body, label).not.toMatch(DIRECT_PHASE_BOOKKEEPING);

      // Stage files carry only the conditional module pointer; that module owns
      // routing and the learnings tool owns writes. No retired direct-write
      // target may return to a stage body.
      expect(body, label).toContain("stage-protocol-learnings.md");
      expect(body, label).toMatch(/`directive\.protocol_modules`\s+lists\s+`learnings`/);
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
      '{{INVOKE}} engine orchestrate report --stage reverse-engineering --result skipped --reason "<reason>"',
    );
    expect(stage("inception", "user-stories")).toContain(
      '{{INVOKE}} engine orchestrate report --stage user-stories --result skipped --reason "<reason>"',
    );
    expect(stage("inception", "requirements-analysis")).toContain(
      "{{INVOKE}} engine recompose --add user-stories",
    );
    expect(stage("inception", "domain-design")).toContain(
      "{{INVOKE}} engine recompose --add units-generation",
    );
  });
});
