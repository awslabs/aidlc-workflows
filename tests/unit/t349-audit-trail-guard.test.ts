// covers: hook:aidlc-state-transition-guard, hook:aidlc-plan-approval-guard
//
// The audit trail under <record>/audit/ is tool-owned: every row is appended by
// an owning tool or hook through appendAuditBlockAtPath. The runtime-integrity
// check shared by the state-transition and plan-approval guards refuses a
// direct write into an audit directory from the model's file-write tools and
// from shell commands, names the owning engine commands instead, and leaves
// reads and the framework's own commands alone. The second block pins the
// protocol prose so the hand-written shard instructions that motivated the
// guard (a stray `$(cat .aidlc-clone-id).md` shard in a live Windows run)
// cannot come back.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AUDIT_TRAIL_REFUSAL,
  RUNTIME_INTEGRITY_REFUSAL,
  runtimeIntegrityViolationKind,
  violatesRuntimeIntegrity,
} from "../../dist/claude/.claude/hooks/runtime-integrity.ts";
import {
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
  seededAuditDir,
  seededAuditShard,
  seededRecordDir,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOKS = join(REPO_ROOT, "dist", "claude", ".claude", "hooks");
const STATE_TRANSITION_GUARD = join(HOOKS, "aidlc-state-transition-guard.ts");
const PLAN_APPROVAL_GUARD = join(HOOKS, "aidlc-plan-approval-guard.ts");

// A representative record-relative audit directory; the classifier is anchored
// on this layout, not on the bare `audit` segment.
const CWD = "/work/proj";
const RECORD = "aidlc/spaces/default/intents/260925-login";
const AUDIT = `${RECORD}/audit`;
const SHARD = `${AUDIT}/host-fixturecloneid01.md`;

function kind(
  tool_name: string,
  tool_input: Record<string, unknown>,
  cwd = CWD,
): string | null {
  return runtimeIntegrityViolationKind({
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    cwd,
  } as never);
}

function bash(command: string, cwd = CWD): string | null {
  return kind("Bash", { command }, cwd);
}

function runHook(
  hook: string,
  payload: Record<string, unknown>,
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.AIDLC_STATE_TRANSITION_OWNER;
  delete env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS;
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", cwd, ...payload }),
    encoding: "utf-8",
    cwd,
    env,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("t349 audit trail guard: file-write tools", () => {
  test("a Write, Edit, MultiEdit, or NotebookEdit into an audit directory is refused as an audit violation", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["Write", { file_path: SHARD }, CWD],
      ["Write", { file_path: `${CWD}/${AUDIT}/$(cat .aidlc-clone-id).md` }, CWD],
      ["Write", { file_path: `${AUDIT}/host-fixturecloneid01.md.bak` }, CWD],
      ["Edit", { file_path: SHARD, old_string: "a", new_string: "b" }, CWD],
      ["MultiEdit", { edits: [{ file_path: "notes.md" }, { file_path: `${AUDIT}/x.md` }] }, CWD],
      ["NotebookEdit", { notebook_path: `${AUDIT}/x.ipynb` }, CWD],
      // The bare space shard directory, used before an intent record exists.
      ["Write", { file_path: "aidlc/spaces/default/intents/audit/space.md" }, CWD],
      // A relative target resolved against a cwd inside the record.
      ["Write", { file_path: "audit/host.md" }, `${CWD}/${RECORD}`],
    ];
    for (const [tool, input, cwd] of cases) {
      expect(kind(tool, input, cwd), JSON.stringify(input)).toBe("audit");
    }
  });

  test("Windows spellings classify like POSIX ones: backslashes, drive letters, case", () => {
    for (const path of [
      String.raw`C:\proj\aidlc\spaces\default\intents\260925-login\audit\host-abc.md`,
      String.raw`c:\proj\AIDLC\Spaces\default\Intents\260925-login\AUDIT\host-abc.md`,
      "c:/proj/aidlc/spaces/default/intents/260925-login/audit/host-abc.md",
      String.raw`\\server\share\proj\aidlc\spaces\team\intents\audit\space.md`,
    ]) {
      expect(kind("Write", { file_path: path }), path).toBe("audit");
      expect(kind("Edit", { file_path: path, old_string: "a", new_string: "b" }), path).toBe("audit");
    }
  });

  test("writes beside the audit directory and a project's own audit folders are allowed", () => {
    for (const path of [
      `${RECORD}/aidlc-state.md`,
      `${RECORD}/inception/requirements-analysis/requirements.md`,
      `${RECORD}/inception/requirements-analysis/requirements-analysis-questions.md`,
      `${RECORD}/audit-notes.md`,
      `${RECORD}/construction/audit/log.md`,
      "aidlc/spaces/default/memory/project.md",
      "src/audit/service.ts",
      "docs/audit/README.md",
      String.raw`C:\proj\src\audit\service.ts`,
    ]) {
      expect(kind("Write", { file_path: path, content: "x" }), path).toBeNull();
      expect(kind("Edit", { file_path: path, old_string: "a", new_string: "b" }), path).toBeNull();
    }
  });

  test("reads of the audit directory are not write targets", () => {
    expect(kind("Read", { file_path: SHARD })).toBeNull();
    expect(kind("Grep", { pattern: "GATE_APPROVED", path: AUDIT })).toBeNull();
    expect(kind("Glob", { pattern: `${AUDIT}/*.md` })).toBeNull();
  });

  test("runtime records still classify as runtime, ahead of the audit class", () => {
    expect(kind("Write", { file_path: "aidlc/.aidlc-sessions/foo.json" })).toBe("runtime");
    expect(bash("echo x > aidlc/.aidlc-sessions/foo.json")).toBe("runtime");
    expect(violatesRuntimeIntegrity({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: SHARD },
      cwd: CWD,
    } as never)).toBe(true);
  });
});

describe("t349 audit trail guard: shell commands", () => {
  test("shell appends, overwrites, copies, moves, removals, and directory creation aimed at a shard are refused", () => {
    for (const command of [
      `cat >> ${SHARD} <<'EOF'\n## Questions: Feasibility\n**Timestamp**: 2026-09-25T00:00:00Z\nEOF`,
      `echo x >> ${SHARD}`,
      `printf '%s\\n' x > ${SHARD}`,
      `printf x | tee -a ${SHARD}`,
      `sed -i 's/a/b/' ${SHARD}`,
      `cp note.md ${AUDIT}/`,
      `cp note.md ${SHARD}`,
      `mv ${SHARD} ${SHARD}.bak`,
      `mv ${AUDIT} ${RECORD}/audit-old`,
      `rm ${SHARD}`,
      `rm -rf ${AUDIT}`,
      `mkdir -p ${AUDIT}`,
      `touch ${SHARD}`,
      `truncate -s 0 ${SHARD}`,
      `dd if=/dev/zero of=${SHARD}`,
      `bash -c 'echo x >> ${SHARD}'`,
      `sh -c "printf x >> ${SHARD}"`,
      // The live incident: a shard named by a command substitution.
      `echo x >> ${AUDIT}/$(cat aidlc/.aidlc-clone-id).md`,
      `echo x >> "${AUDIT}/$(hostname)-$(cat aidlc/.aidlc-clone-id).md"`,
      // Quoted Windows spellings and the PowerShell cmdlets the parser knows.
      `Set-Content -Path 'C:\\proj\\aidlc\\spaces\\default\\intents\\260925-login\\audit\\host.md' -Value y`,
      `Add-Content -Path "C:\\proj\\aidlc\\spaces\\default\\intents\\260925-login\\audit\\host.md" -Value y`,
      `echo y | Out-File "C:\\proj\\aidlc\\spaces\\default\\intents\\260925-login\\audit\\host.md" -Append`,
      `echo x >> "C:\\proj\\aidlc\\spaces\\default\\intents\\260925-login\\audit\\host.md"`,
      `echo x >> C:/proj/AIDLC/Spaces/default/Intents/260925-login/Audit/host.md`,
      `Remove-Item -Path 'C:\\proj\\aidlc\\spaces\\default\\intents\\260925-login\\audit'`,
    ]) {
      expect(bash(command), command).toBe("audit");
    }
  });

  test("reads and redirects elsewhere pass, and so do the framework's own audit-writing commands", () => {
    for (const command of [
      `cat ${SHARD}`,
      `grep -rn GATE_APPROVED ${AUDIT}/`,
      `ls -la ${AUDIT}`,
      `tail -n 40 ${SHARD}`,
      `sed -n '1,20p' ${SHARD}`,
      `sort ${AUDIT}/*.md > /tmp/all.md`,
      `cp ${SHARD} /tmp/`,
      `bun .claude/tools/aidlc-log.ts decision --stage feasibility --decision "How would you like to answer the questions?" --options "Guide me,I'll edit the file,Chat"`,
      `bun .claude/tools/aidlc.ts engine log answer --stage feasibility --details "see ${SHARD} for context"`,
      `aidlc engine log review --stage feasibility --reviewer aidlc-product-lead-agent --iteration 1`,
      `aidlc engine audit append-raw "Error: probe" "**Severity**: Low\\n**Description**: probe note"`,
      `bun .claude/tools/aidlc-audit.ts append ERROR_LOGGED --field Details=x --project-dir ${CWD}`,
      `bun .claude/tools/aidlc-audit.ts audit-merge --slug login --project-dir ${CWD}`,
      `bun .claude/tools/aidlc-orchestrate.ts report --stage feasibility --result approved --user-input Approve`,
      `bun .claude/tools/aidlc-log.ts answer --stage feasibility --details y 2>&1 | tee /tmp/log.txt`,
      `bun .claude/tools/aidlc-utility.ts doctor --project-dir ${CWD} > /dev/null`,
    ]) {
      expect(bash(command), command).toBeNull();
    }
  });

  test("an unresolvable shell target is not classified and the call is allowed, matching the runtime-record policy", () => {
    // The shared target parser drops paths carrying shell variables or globs
    // and resolves relative targets against the hook's cwd, not a `cd` earlier
    // in the command. The runtime-record check accepts the same gap; the
    // fail-open answer is consistent across both classes.
    for (const command of [
      `echo x >> $RECORD/audit/host.md`,
      `echo x >> ${AUDIT}/*.md`,
      `cd ${RECORD} && echo x >> audit/host.md`,
      // An unquoted backslash path is read with POSIX escape semantics by the
      // shared parser; quoted backslash paths and forward slashes are classified.
      `echo x >> C:\\proj\\aidlc\\spaces\\default\\intents\\260925-login\\audit\\host.md`,
    ]) {
      expect(bash(command), command).toBeNull();
    }
  });
});

describe("t349 audit trail guard: the hooks refuse with the owning routes named", () => {
  let project = "";
  let shard = "";

  beforeAll(() => {
    project = createTestProject();
    seedAuditFile(project);
    shard = seededAuditShard(project);
  });

  afterAll(() => {
    cleanupTestProject(project);
  });

  test("the refusal is one sentence that names the engine routes", () => {
    expect(AUDIT_TRAIL_REFUSAL).toContain("engine log decision");
    expect(AUDIT_TRAIL_REFUSAL).toContain("engine log answer");
    expect(AUDIT_TRAIL_REFUSAL).toContain("engine audit append-raw");
    expect(AUDIT_TRAIL_REFUSAL).toContain("engine orchestrate report");
    expect(AUDIT_TRAIL_REFUSAL.trim().split(/(?<=[.!?])\s+/)).toHaveLength(1);
    expect(AUDIT_TRAIL_REFUSAL).not.toBe(RUNTIME_INTEGRITY_REFUSAL);
  });

  test("the state-transition guard refuses direct and shell writes to the seeded shard on both hooks", () => {
    const before = readFileSync(shard, "utf-8");
    for (const hook of [STATE_TRANSITION_GUARD, PLAN_APPROVAL_GUARD]) {
      for (const payload of [
        { tool_name: "Write", tool_input: { file_path: shard, content: "## Forged\n" } },
        { tool_name: "Edit", tool_input: { file_path: shard, old_string: "AI-DLC", new_string: "x" } },
        { tool_name: "Write", tool_input: { file_path: join(seededAuditDir(project), "$(cat .aidlc-clone-id).md"), content: "x" } },
        { tool_name: "Bash", tool_input: { command: `echo '## Forged' >> "${shard}"` } },
        { tool_name: "Bash", tool_input: { command: `cat >> "${shard}" <<'EOF'\n## Forged\nEOF` } },
        { tool_name: "Bash", tool_input: { command: `mv "${shard}" "${shard}.bak"` } },
      ]) {
        const r = runHook(hook, payload, project);
        expect(r.status, `${hook} ${JSON.stringify(payload)}`).toBe(2);
        expect(r.stderr, `${hook} ${JSON.stringify(payload)}`).toContain(AUDIT_TRAIL_REFUSAL);
        expect(r.stderr).not.toContain("AIDLC runtime records and hooks belong to the harness");
      }
    }
    // Nothing reached the shard.
    expect(readFileSync(shard, "utf-8")).toBe(before);
    expect(readdirSync(seededAuditDir(project))).toEqual([basename(shard)]);
  });

  test("reads and ordinary record writes pass through the state-transition guard", () => {
    for (const payload of [
      { tool_name: "Read", tool_input: { file_path: shard } },
      { tool_name: "Bash", tool_input: { command: `cat "${shard}"` } },
      { tool_name: "Bash", tool_input: { command: `grep -c STAGE_STARTED "${shard}"` } },
      { tool_name: "Write", tool_input: { file_path: join(seededRecordDir(project), "inception", "feasibility", "feasibility.md"), content: "# ok\n" } },
      { tool_name: "Bash", tool_input: { command: `bun .claude/tools/aidlc-log.ts decision --stage feasibility --decision "How would you like to answer the questions?" --options "Guide me,I'll edit the file,Chat"` } },
    ]) {
      const r = runHook(STATE_TRANSITION_GUARD, payload, project);
      expect(r.status, JSON.stringify(payload)).toBe(0);
      expect(r.stderr, JSON.stringify(payload)).toBe("");
    }
    expect(statSync(shard).isFile()).toBe(true);
  });
});

describe("t349 audit trail prose: the manual-write instructions stay gone", () => {
  const read = (...parts: string[]): string => readFileSync(join(REPO_ROOT, ...parts), "utf-8");
  const protocol = read("core", "aidlc-common", "protocols", "stage-protocol.md");

  test("the stage protocol no longer directs a hand-written audit entry", () => {
    for (const phrase of [
      "cat >>",
      "Question interaction log format",
      "Audit log format for conversation events",
      "Specialized audit log formats",
      "#### Error log format",
      "#### Recovery log format",
      "#### Change Request log format",
      "ALWAYS append to this clone's audit shard",
      "If this clone's audit shard does not exist, create it",
      "create a backup (`<record>/audit/",
      "For manual audit entries",
      "Each batch entry requires its own `date -u` Bash call",
      "Log the user's mode choice to `<record>/audit/",
      "Log each batch to `<record>/audit/",
      "log the decision in `<record>/audit/",
      "# AI-DLC Audit Log",
      "[ISO timestamp from Bash]",
    ]) {
      expect(protocol, phrase).not.toContain(phrase);
    }
  });

  test("the stage protocol names the tool-owned routes in their place", () => {
    expect(protocol).toContain("### Audit trail rules");
    expect(protocol).toContain("{{INVOKE}} engine log decision");
    expect(protocol).toContain("{{INVOKE}} engine log answer");
    expect(protocol).toContain('{{INVOKE}} engine audit append-raw "<heading>" "<body>"');
    expect(protocol).toContain('--result approved --user-input "Accept as-is"');
    expect(protocol).toContain("Never write the audit shard yourself");
  });

  test("the protocol modules and shared knowledge route their notes through the tools", () => {
    const recovery = read("core", "aidlc-common", "protocols", "stage-protocol-recovery.md");
    const ensemble = read("core", "aidlc-common", "protocols", "stage-protocol-ensemble.md");
    const governance = read("core", "aidlc-common", "protocols", "stage-protocol-governance.md");
    const auditFormat = read("core", "knowledge", "aidlc-shared", "audit-format.md");
    for (const [text, phrase] of [
      [recovery, "log in `<record>/audit/"],
      [recovery, "Log the resolution in `<record>/audit/"],
      [recovery, "Document the change in `<record>/audit/"],
      [ensemble, "using the Error log format"],
      [governance, "Log a `PHASE_VERIFIED` event to"],
      [auditFormat, "Generate fresh timestamp for EACH entry via"],
      [auditFormat, "### Error Format"],
      [auditFormat, "### Recovery Format"],
    ] as const) {
      expect(text, phrase).not.toContain(phrase);
    }
    expect(recovery.match(/engine audit append-raw/g)?.length).toBe(3);
    expect(ensemble).toContain("engine audit append-raw");
    expect(governance).toContain("emitted by the engine");
    expect(auditFormat).toContain("### Free-form note format (`append-raw`)");
  });

  test("no shipped prose tells an agent to append to a shard with the shell or to create one", () => {
    const roots = [
      ["core", "aidlc-common"],
      ["core", "knowledge"],
      ["core", "agents"],
      ["core", "memory"],
      ["core", "skills"],
      ["core", "templates"],
    ].map((parts) => join(REPO_ROOT, ...parts));
    for (const name of readdirSync(join(REPO_ROOT, "harness"))) {
      roots.push(join(REPO_ROOT, "harness", name, "skills"));
    }
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(?:md|mdc)$/.test(entry)) continue;
        const text = readFileSync(path, "utf-8");
        for (const phrase of [
          "cat >>",
          "audit shard does not exist",
          "# AI-DLC Audit Log",
          "using the Error log format",
          "Question interaction log format",
        ]) {
          if (text.includes(phrase)) offenders.push(`${path}: ${phrase}`);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
