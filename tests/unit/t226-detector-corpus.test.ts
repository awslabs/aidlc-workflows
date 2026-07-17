// covers: hook:aidlc-stop, hook:aidlc-runtime-compile
//
// Pins the both-shape detector contract for the stop hook and runtime-compile
// hook. The legacy tool-file shape is a permanent input: plugin manifests and
// dev mode keep emitting it even after the new `aidlc ...` grammar exists.
//
// Provenance: ported from the spike-proven detector corpus. Per-case notes are
// preserved below. The documented false-positive classes are raw command-string
// matching of quoted command echoes and English-prose mentions; this is shared
// with the legacy detectors and intentionally fails closed.

import { describe, expect, test } from "bun:test";
import {
  classifyRuntimeCompileCommand,
  isEngineToolCall,
} from "../../core/tools/aidlc-lib.ts";

type RuntimeCompileDecision = "reject" | "fire" | "pass";

type CorpusKind =
  | "old"
  | "new-twin"
  | "composite"
  | "readonly"
  | "negative"
  | "guard"
  | "semantic-edge";

type DocumentedFalsePositive = "d1" | "d2" | "both";

interface CorpusCase {
  id: string;
  cmd: string;
  d1: boolean;
  d2: RuntimeCompileDecision;
  kind: CorpusKind;
  note: string;
  twinOf?: string;
  documentedFalsePositive?: DocumentedFalsePositive;
}

// Harvest notes:
// - Required grep commands were run against core/ and harness/claude/skills/aidlc/SKILL.md.
// - Some required examples exist on disk as tool usage strings or emitted strings, not
//   as full "bun .claude/tools/..." prose. Those are normalized to the old .claude
//   command shape below and called out in the note.
// - d1 and d2 are the expected final classifications. For old-shape cases, tests
//   assert these labels are also current detector results.

const corpus: CorpusCase[] = [
  {
    id: "old-orchestrate-next",
    cmd: "bun .claude/tools/aidlc-orchestrate.ts next $ARGUMENTS",
    d1: true,
    d2: "pass",
    kind: "old",
    note: "harness/claude/skills/aidlc/SKILL.md line 40.",
  },
  {
    id: "new-orchestrate-next",
    cmd: "aidlc next $ARGUMENTS",
    d1: true,
    d2: "pass",
    kind: "new-twin",
    twinOf: "old-orchestrate-next",
    note: "New grammar twin of orchestrate next.",
  },
  {
    id: "old-orchestrate-next-scope",
    cmd: "bun .claude/tools/aidlc-orchestrate.ts next --scope feature",
    d1: true,
    d2: "pass",
    kind: "old",
    note: "tmp/aidlc-single-cli/vision.html line 271.",
  },
  {
    id: "new-orchestrate-next-scope",
    cmd: "aidlc next --scope feature",
    d1: true,
    d2: "pass",
    kind: "new-twin",
    twinOf: "old-orchestrate-next-scope",
    note: "New grammar twin of next with scope.",
  },
  {
    id: "old-orchestrate-report",
    cmd: "bun .claude/tools/aidlc-orchestrate.ts report --stage application-design --result approved --user-input \"Approve\"",
    d1: true,
    d2: "fire",
    kind: "old",
    note: "harness/claude/skills/aidlc/SKILL.md line 42, with placeholders made concrete.",
  },
  {
    id: "new-orchestrate-report",
    cmd: "aidlc report --stage application-design --result approved --user-input \"Approve\"",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-orchestrate-report",
    note: "New grammar twin of report.",
  },
  {
    id: "old-orchestrate-report-approved",
    cmd: "bun .claude/tools/aidlc-orchestrate.ts report --stage practices-discovery --result approved --user-input \"exact label\"",
    d1: true,
    d2: "fire",
    kind: "old",
    note: "core/aidlc-common/stages/inception/practices-discovery.md line 120, normalized from HARNESS_DIR.",
  },
  {
    id: "new-orchestrate-report-approved",
    cmd: "aidlc report --stage practices-discovery --result approved --user-input \"exact label\"",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-orchestrate-report-approved",
    note: "Gate approval recompile twin.",
  },
  {
    id: "old-orchestrate-next-status",
    cmd: "bun .claude/tools/aidlc-orchestrate.ts next --status",
    d1: false,
    d2: "pass",
    kind: "readonly",
    note: "Read-only carve-out described in core/hooks/aidlc-stop.ts lines 556-577.",
  },
  {
    id: "new-orchestrate-next-status",
    cmd: "aidlc next --status",
    d1: false,
    d2: "pass",
    kind: "readonly",
    twinOf: "old-orchestrate-next-status",
    note: "New grammar read-only carve-out.",
  },
  {
    id: "old-orchestrate-park",
    cmd: "bun .claude/tools/aidlc-orchestrate.ts park",
    d1: false,
    d2: "pass",
    kind: "old",
    note: "harness/claude/skills/aidlc/SKILL.md line 66. Current D1 does not count old park.",
  },
  {
    id: "new-orchestrate-park",
    cmd: "aidlc park",
    d1: true,
    d2: "pass",
    kind: "new-twin",
    twinOf: "old-orchestrate-park",
    note: "Promoted top-level park is mutating in the new grammar.",
  },
  {
    id: "old-state-approve",
    cmd: "bun .claude/tools/aidlc-state.ts approve application-design --user-input \"Approve\"",
    d1: true,
    d2: "fire",
    kind: "old",
    note: "core/tools/aidlc-state.ts line 1530 usage, normalized to .claude.",
  },
  {
    id: "new-state-approve",
    cmd: "aidlc state approve application-design --user-input \"Approve\"",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-state-approve",
    note: "New grammar state approve.",
  },
  {
    id: "old-state-get",
    cmd: "bun .claude/tools/aidlc-state.ts get \"Current Stage\"",
    d1: false,
    d2: "fire",
    kind: "old",
    note: "core/tools/aidlc-state.ts line 489 usage, normalized to .claude.",
  },
  {
    id: "new-state-get",
    cmd: "aidlc state get --field \"Current Stage\"",
    d1: false,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-state-get",
    note: "New grammar read-only state query; D2 fires by state-tool parity.",
  },
  {
    id: "old-state-gate-start",
    cmd: "bun .claude/tools/aidlc-state.ts gate-start application-design",
    d1: true,
    d2: "fire",
    kind: "old",
    note: "core/aidlc-common/protocols/stage-protocol.md line 159, normalized from HARNESS_DIR.",
  },
  {
    id: "new-state-gate-start",
    cmd: "aidlc state gate-start application-design",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-state-gate-start",
    note: "New grammar gate-start.",
  },
  {
    id: "old-state-reject",
    cmd: "bun .claude/tools/aidlc-state.ts reject application-design --feedback \"text\"",
    d1: true,
    d2: "fire",
    kind: "old",
    note: "core/aidlc-common/protocols/stage-protocol.md line 163, normalized from HARNESS_DIR.",
  },
  {
    id: "new-state-reject",
    cmd: "aidlc state reject application-design --feedback \"text\"",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-state-reject",
    note: "New grammar reject.",
  },
  {
    id: "old-state-revise",
    cmd: "bun .claude/tools/aidlc-state.ts revise application-design",
    d1: true,
    d2: "fire",
    kind: "old",
    note: "core/aidlc-common/protocols/stage-protocol.md line 163, normalized from HARNESS_DIR.",
  },
  {
    id: "new-state-revise",
    cmd: "aidlc state revise application-design",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-state-revise",
    note: "New grammar revise.",
  },
  {
    id: "old-state-advance",
    cmd: "bun .claude/tools/aidlc-state.ts advance \"completed-slug\" \"next-slug\"",
    d1: true,
    d2: "fire",
    kind: "old",
    note: "core/aidlc-common/protocols/stage-protocol.md line 469, normalized from HARNESS_DIR.",
  },
  {
    id: "new-state-advance",
    cmd: "aidlc state advance \"completed-slug\" \"next-slug\"",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-state-advance",
    note: "New grammar advance.",
  },
  {
    id: "old-state-finalize",
    cmd: "bun .claude/tools/aidlc-state.ts finalize \"completed-slug\"",
    d1: true,
    d2: "fire",
    kind: "old",
    note: "core/aidlc-common/protocols/stage-protocol.md line 475, normalized from HARNESS_DIR.",
  },
  {
    id: "new-state-finalize",
    cmd: "aidlc state finalize \"completed-slug\"",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-state-finalize",
    note: "New grammar finalize.",
  },
  {
    id: "old-state-checkbox",
    cmd: "bun .claude/tools/aidlc-state.ts checkbox \"application-design=completed\"",
    d1: true,
    d2: "fire",
    kind: "old",
    note: "core/aidlc-common/protocols/stage-protocol.md line 449, normalized from HARNESS_DIR.",
  },
  {
    id: "new-state-checkbox",
    cmd: "aidlc state checkbox \"application-design=completed\"",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-state-checkbox",
    note: "New grammar checkbox.",
  },
  {
    id: "old-jump-execute",
    cmd: "bun .claude/tools/aidlc-jump.ts execute --target code-generation --direction forward --scope feature",
    d1: true,
    d2: "fire",
    kind: "old",
    note: "core/tools/aidlc-orchestrate.ts line 2480 emitted string, normalized to .claude.",
  },
  {
    id: "new-jump-execute",
    cmd: "aidlc jump execute --target code-generation --direction forward --scope feature",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-jump-execute",
    note: "New grammar jump execute.",
  },
  {
    id: "old-bolt-dispatch-event",
    cmd: "bun .claude/tools/aidlc-bolt.ts dispatch-event --event MERGE_DISPATCH_INVOKED --slug example",
    d1: true,
    d2: "fire",
    kind: "old",
    note: "core/tools/aidlc-bolt.ts lines 677-679 usage, normalized to .claude.",
  },
  {
    id: "new-bolt-dispatch-event",
    cmd: "aidlc bolt dispatch-event --event MERGE_DISPATCH_INVOKED --slug example",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-bolt-dispatch-event",
    note: "New grammar bolt dispatch-event.",
  },
  {
    id: "old-swarm-prepare",
    cmd: "bun .claude/tools/aidlc-swarm.ts prepare --batch 2 --units a,b,c",
    d1: true,
    d2: "pass",
    kind: "old",
    note: "harness/claude/skills/aidlc/SKILL.md line 61 and tmp/aidlc-single-cli/vision.html line 274.",
  },
  {
    id: "new-swarm-prepare",
    cmd: "aidlc swarm prepare --batch 2 --units a,b,c",
    d1: true,
    d2: "pass",
    kind: "new-twin",
    twinOf: "old-swarm-prepare",
    note: "New grammar swarm prepare.",
  },
  {
    id: "old-swarm-finalize",
    cmd: "bun .claude/tools/aidlc-swarm.ts finalize --batch 2 --units a,b,c --claimed a,b --check-cmd \"bun test\"",
    d1: true,
    d2: "pass",
    kind: "old",
    note: "harness/claude/skills/aidlc/SKILL.md line 61, concrete finalize form.",
  },
  {
    id: "new-swarm-finalize",
    cmd: "aidlc swarm finalize --batch 2 --units a,b,c --claimed a,b --check-cmd \"bun test\"",
    d1: true,
    d2: "pass",
    kind: "new-twin",
    twinOf: "old-swarm-finalize",
    note: "New grammar swarm finalize.",
  },
  {
    id: "old-utility-status",
    cmd: "bun .claude/tools/aidlc-utility.ts status",
    d1: false,
    d2: "fire",
    kind: "old",
    note: "tmp/aidlc-single-cli/vision.html line 89.",
  },
  {
    id: "new-status",
    cmd: "aidlc status",
    d1: false,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-utility-status",
    note: "Bare status stays out of D1 but fires D2 by utility parity.",
  },
  {
    id: "old-utility-doctor",
    cmd: "bun .claude/tools/aidlc-utility.ts doctor",
    d1: false,
    d2: "fire",
    kind: "old",
    note: "core/tools/aidlc-utility.ts line 4186 usage, normalized to .claude.",
  },
  {
    id: "new-doctor",
    cmd: "aidlc doctor",
    d1: false,
    d2: "fire",
    kind: "negative",
    twinOf: "old-utility-doctor",
    documentedFalsePositive: "d2",
    note: "D1 negative. D2 deliberately preserves old utility false-fire parity.",
  },
  {
    id: "old-utility-version",
    cmd: "bun .claude/tools/aidlc-utility.ts version",
    d1: false,
    d2: "fire",
    kind: "old",
    note: "core/tools/aidlc-utility.ts line 4186 usage, normalized to .claude.",
  },
  {
    id: "new-version",
    cmd: "aidlc version",
    d1: false,
    d2: "fire",
    kind: "negative",
    twinOf: "old-utility-version",
    documentedFalsePositive: "d2",
    note: "D1 negative. D2 deliberately preserves old utility false-fire parity.",
  },
  {
    id: "old-utility-help",
    cmd: "bun .claude/tools/aidlc-utility.ts help",
    d1: false,
    d2: "fire",
    kind: "old",
    note: "harness/claude/skills/aidlc/SKILL.md line 7.",
  },
  {
    id: "new-help",
    cmd: "aidlc help",
    d1: false,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-utility-help",
    note: "D2 utility parity for help.",
  },
  {
    id: "old-utility-set-status",
    cmd: "bun .claude/tools/aidlc-utility.ts set-status --stage application-design",
    d1: false,
    d2: "fire",
    kind: "old",
    note: "core/hooks/aidlc-sync-statusline.ts lines 108-111 and core/tools/aidlc-utility.ts line 3757.",
  },
  {
    id: "new-state-set-status",
    cmd: "aidlc state set-status --stage application-design",
    d1: true,
    d2: "fire",
    kind: "new-twin",
    twinOf: "old-utility-set-status",
    note: "New grammar moves set-status under state; D1 now treats it as mutating.",
  },
  {
    id: "old-runner-gen-write",
    cmd: "bun .claude/tools/aidlc-runner-gen.ts write",
    d1: false,
    d2: "pass",
    kind: "old",
    note: "core/templates/onboarding.md line 14 and core/tools/aidlc-runner-gen.ts line 362.",
  },
  {
    id: "new-gen-runners",
    cmd: "aidlc gen runners",
    d1: false,
    d2: "pass",
    kind: "new-twin",
    twinOf: "old-runner-gen-write",
    note: "New grammar generator command remains outside D1 and D2.",
  },
  {
    id: "old-sensor-fire",
    cmd: "bun .claude/tools/aidlc-sensor.ts fire linter --stage code-generation --output-path out.md",
    d1: false,
    d2: "pass",
    kind: "old",
    note: "core/hooks/aidlc-sensor-fire.ts lines 4 and 198-203, normalized to .claude.",
  },
  {
    id: "new-sensor-fire",
    cmd: "aidlc sensor fire linter",
    d1: false,
    d2: "pass",
    kind: "new-twin",
    twinOf: "old-sensor-fire",
    note: "New grammar sensor fire remains outside D1 and D2.",
  },
  {
    id: "old-runtime-compile",
    cmd: "bun .claude/tools/aidlc-runtime.ts compile",
    d1: false,
    d2: "reject",
    kind: "guard",
    note: "core/hooks/aidlc-runtime-compile.ts lines 63-74 recursion guard.",
  },
  {
    id: "new-runtime-compile",
    cmd: "aidlc runtime compile",
    d1: false,
    d2: "reject",
    kind: "guard",
    twinOf: "old-runtime-compile",
    note: "New grammar recursion guard twin.",
  },
  {
    id: "composite-cd-state",
    cmd: "cd foo && aidlc state approve",
    d1: true,
    d2: "fire",
    kind: "composite",
    note: "Composite command from the brief.",
  },
  {
    id: "composite-next-report",
    cmd: "aidlc next && aidlc report --result approved",
    d1: true,
    d2: "fire",
    kind: "composite",
    note: "Composite next then report from the brief.",
  },
  {
    id: "composite-env-state",
    cmd: "VAR=1 aidlc state approve",
    d1: true,
    d2: "fire",
    kind: "composite",
    note: "Environment prefix case from the brief.",
  },
  {
    id: "old-quoted-echo",
    cmd: "echo \"bun .claude/tools/aidlc-state.ts approve application-design\"",
    d1: true,
    d2: "fire",
    kind: "semantic-edge",
    documentedFalsePositive: "both",
    note: "Quoted old-shape mention. Current regexes inspect raw text and match it.",
  },
  {
    id: "new-quoted-echo",
    cmd: "echo \"aidlc state approve\"",
    d1: true,
    d2: "fire",
    kind: "semantic-edge",
    documentedFalsePositive: "both",
    twinOf: "old-quoted-echo",
    note: "Quoted new-shape mention preserves the shared raw-text limitation.",
  },
  {
    id: "plain-git",
    cmd: "git status",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Plain shell command negative.",
  },
  {
    id: "plain-ls",
    cmd: "ls -la",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Plain shell command negative.",
  },
  {
    id: "plain-cat",
    cmd: "cat core/hooks/aidlc-stop.ts",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Reading a file with an AIDLC filename is not an engine command.",
  },
  {
    id: "negative-plugin-select",
    cmd: "aidlc plugin select aidlc,test-pro",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Plugin command negative from the brief.",
  },
  {
    id: "negative-workspace-detect",
    cmd: "aidlc workspace detect",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Workspace scan negative from the brief; not a D2 transition-class new spelling.",
  },
  {
    id: "negative-worktree-path",
    cmd: "cd .claude/worktrees/aidlc-state-fix && ls",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Known trap. Current D1 fast reject sees aidlc-state, but segment logic stays false.",
  },
  {
    id: "negative-stated",
    cmd: "aidlc stated approve",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "No boundary after state noun.",
  },
  {
    id: "negative-aidlcstate",
    cmd: "aidlcstate approve",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "No word boundary before command name.",
  },
  {
    id: "negative-statusline",
    cmd: "aidlc statusline",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Statusline is not engine engagement or a runtime compile trigger.",
  },
  {
    id: "negative-gen-check",
    cmd: "aidlc gen runners --check",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Generator command must not match D1 or D2.",
  },
  {
    id: "negative-config-get",
    cmd: "aidlc config get depth",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Config get is read-only and not a D2 transition-class utility split.",
  },
  {
    id: "negative-intent-help",
    cmd: "aidlc intent help",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Intent workspace verb is out of D1 and D2.",
  },
  {
    id: "negative-space",
    cmd: "aidlc space default",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Space workspace verb is out of D1 and D2.",
  },
  {
    id: "negative-log",
    cmd: "bun .claude/tools/aidlc-log.ts decision --stage x",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Log tool is not in the D1 or D2 allowlists.",
  },
  {
    id: "negative-worktree",
    cmd: "bun .claude/tools/aidlc-worktree.ts info --slug x",
    d1: false,
    d2: "pass",
    kind: "negative",
    note: "Worktree tool is not in the D1 or D2 allowlists.",
  },
  {
    id: "english-new-mention",
    cmd: "Run aidlc state approve",
    d1: true,
    d2: "fire",
    kind: "semantic-edge",
    documentedFalsePositive: "both",
    note: "Longer English sentence. Raw command-string matching cannot distinguish this from a shell fragment.",
  },
  {
    id: "new-report-result-only",
    cmd: "aidlc report --result approved",
    d1: true,
    d2: "fire",
    kind: "composite",
    note: "P4 gate-approval recompile case.",
  },
  {
    id: "new-leading-space-state",
    cmd: " aidlc state approve",
    d1: true,
    d2: "fire",
    kind: "composite",
    note: "P4 leading-space case.",
  },
  {
    id: "new-scope-change",
    cmd: "aidlc scope change feature",
    d1: false,
    d2: "fire",
    kind: "composite",
    note: "New utility split that remains transition-class for D2.",
  },
  {
    id: "new-config-set",
    cmd: "aidlc config set depth comprehensive",
    d1: false,
    d2: "fire",
    kind: "composite",
    note: "New utility split that remains transition-class for D2.",
  },
];

const oldShapeCases = corpus.filter((c) => c.kind === "old");
const negativeCases = corpus.filter((c) => c.kind === "negative");

function d1(cmd: string): boolean {
  return isEngineToolCall("bash", { command: cmd });
}

describe("detector corpus", () => {
  test("full corpus matches both-shape detector labels", () => {
    for (const c of corpus) {
      expect(d1(c.cmd), `${c.id} D1`).toBe(c.d1);
      expect(classifyRuntimeCompileCommand(c.cmd), `${c.id} D2`).toBe(c.d2);
    }
  });

  test("old-shape labels remain current detector behavior", () => {
    for (const c of oldShapeCases) {
      expect(d1(c.cmd), `${c.id} old-shape D1`).toBe(c.d1);
      expect(classifyRuntimeCompileCommand(c.cmd), `${c.id} old-shape D2`).toBe(c.d2);
    }
  });

  test("negatives stay negative except documented false positives", () => {
    for (const c of negativeCases) {
      if (c.documentedFalsePositive !== "d1" && c.documentedFalsePositive !== "both") {
        expect(d1(c.cmd), `${c.id} D1 negative`).toBe(false);
      }
      if (c.documentedFalsePositive !== "d2" && c.documentedFalsePositive !== "both") {
        expect(classifyRuntimeCompileCommand(c.cmd), `${c.id} D2 negative`).toBe("pass");
      }
    }
  });

  test("explicit regression guards", () => {
    expect(d1("cd x && aidlc state approve")).toBe(true);
    expect(classifyRuntimeCompileCommand("cd x && aidlc state approve")).toBe("fire");

    expect(classifyRuntimeCompileCommand("aidlc report --result approved")).toBe("fire");

    expect(d1(" aidlc state approve")).toBe(true);
    expect(classifyRuntimeCompileCommand(" aidlc state approve")).toBe("fire");

    expect(classifyRuntimeCompileCommand("aidlc runtime compile")).toBe("reject");
    expect(classifyRuntimeCompileCommand("cd x && aidlc runtime compile")).toBe("reject");
    expect(
      classifyRuntimeCompileCommand(
        'aidlc state approve application-design --user-input "aidlc runtime notes"',
      ),
    ).toBe("fire");
    expect(
      classifyRuntimeCompileCommand(
        'aidlc state approve application-design --user-input "notes; aidlc runtime compile"',
      ),
    ).toBe("fire");
    expect(
      classifyRuntimeCompileCommand(
        "aidlc state approve application-design --user-input 'notes && aidlc runtime compile'",
      ),
    ).toBe("fire");
  });

  test("new top-level park is intentional engagement", () => {
    // Intended delta: new-shape `aidlc park` mutates workflow state.
    expect(d1("aidlc park")).toBe(true);
  });
});
