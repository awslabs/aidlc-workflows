// covers: function:unshownGateReplyStands, function:verifyApprovalDecision, cli:aidlc-orchestrate(report)
//
// An approval reported for a stage whose gate the record never shows stands on
// a reply in the chat that reports it.
// On every tool, through its own hook wiring and its own shell for the agent's
// command (tests/harness/scope-hosts.ts), the chat the agent's report names is
// the chat the human-turn hook recorded for the person's reply in that chat:
// with two other chats' replies on record, their "Approve" in this chat
// approves, and a chat whose only turn was `/aidlc --resume` approves nothing.
//
// Mechanism: function - each tool's shipped hooks and engine tree on a seeded
// project; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { basename } from "node:path";
import { REPO_ROOT, seededRecordDir, seedStateFile } from "../harness/fixtures.ts";
import { hostFor, type HostName } from "../harness/scope-hosts.ts";
import type { ScopeHost } from "../harness/scope-run.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "feasibility";
const HOSTS: Array<"claude" | HostName> = ["claude", "codex", "kiro", "kiro-ide", "cursor", "opencode", "copilot"];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// The tool's tree as it ships, the work at Feasibility (running, its gate never
// shown), and the guards a person's run has; the stage's own output checks are
// off, as the bare fixture makes no output. The presence guard is on.
function project(name: "claude" | HostName): ScopeHost {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `aidlc-unshown-${name}-`)));
  const proj = join(root, "proj");
  cpSync(join(REPO_ROOT, "dist", name), proj, { recursive: true });
  seedStateFile(proj, "state-mid-ideation.md");
  const host = hostFor(name, proj);
  Object.assign(host.env, {
    AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1", AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
  });
  cleanups.push(() => {
    (host as ScopeHost & { dispose?: () => void }).dispose?.();
    rmSync(root, { recursive: true, force: true });
  });
  host.sessionStart("startup");
  return host;
}

const rows = (host: ScopeHost, event: string) => readAuditShardEvents(host.proj).filter((row) => row.event === event);

// The person picks the work up in this chat with `/aidlc --resume`; the agent
// runs `next --resume` (Kiro CLI holds the first `next` to the person's own
// arguments), joins the chat to the work, as the engine's step for a chat that
// has not joined names, and runs `next` (on Copilot, the chat's own `next`
// takes the work's step over from the chat before).
function resume(host: ScopeHost): void {
  host.typed("/aidlc --resume");
  const resumed = host.engine("orchestrate", "next", "--resume");
  expect(resumed.status, `${resumed.stdout}${resumed.stderr}`).toBe(0);
  const joined = host.engine("intent", basename(seededRecordDir(host.proj)));
  expect(joined.status, `${joined.stdout}${joined.stderr}`).toBe(0);
  const next = host.engine("orchestrate", "next");
  expect(next.status, `${next.stdout}${next.stderr}`).toBe(0);
}

// Two chats pick the work up and the person replies there to something else;
// then a third chat picks it up and, when `last` is given, they type it there.
function threeChats(host: ScopeHost, last: string | null): void {
  resume(host);
  host.typed("option 4");
  host.newSession();
  resume(host);
  host.typed("Nothing to add");
  host.newSession();
  resume(host);
  if (last !== null) host.typed(last);
}

function reportApproved(host: ScopeHost) {
  return host.engine("orchestrate", "report", "--stage", STAGE, "--result", "approved", "--user-input", "Approve");
}

describe("t-unshown-gate-same-chat: the chat a report names is the chat the person replied in", () => {
  for (const name of HOSTS) {
    test(`${name}: their Approve in this chat approves a gate never shown, with two other chats' replies on record`, () => {
      const host = project(name);
      threeChats(host, "Approve");
      const reply = rows(host, "HUMAN_TURN").at(-1)!;
      const approved = reportApproved(host);
      const gate = rows(host, "GATE_APPROVED");
      expect(gate.length, `${approved.stdout}${approved.stderr}`).toBe(1);
      expect(auditBlockField(gate[0].block, "Message Id")).toBe(auditBlockField(reply.block, "Message Id"));
    });

    test(`${name}: a chat whose only turn was /aidlc --resume approves nothing`, () => {
      const host = project(name);
      threeChats(host, null);
      const refused = reportApproved(host);
      expect(`${refused.stdout}${refused.stderr}`).toContain("no reply of the person's in this chat since this stage last started answers this gate");
      expect(rows(host, "GATE_APPROVED")).toEqual([]);
    });
  }
});
