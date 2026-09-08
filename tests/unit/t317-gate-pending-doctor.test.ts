// covers: subcommand:aidlc-utility:doctor
//
// t317 - doctor distinguishes a long-open human approval gate from a stuck
// workflow. The probe is advisory: a stale organic gate-open row adds a PASS
// line with its duration and /aidlc --status guidance, while fresh, resolved,
// recovered-only, and absent gates stay silent. The advisory never changes the
// process exit code contributed by the rest of doctor's checks.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededAuditDir,
  seededAuditShard,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  GATE_PENDING_ADVISORY_MS,
} from "../../dist/claude/.claude/tools/aidlc-utility.ts";

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const STATE_FIXTURE = join(import.meta.dir, "..", "fixtures", "state-mid-ideation.md");

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

function projectAtGate(): string {
  const proj = createTestProject();
  created.push(proj);
  seedStateFile(proj, STATE_FIXTURE);
  const statePath = seededStateFile(proj);
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf-8").replace(
      /^- \[-\] feasibility/m,
      "- [?] feasibility",
    ),
    "utf-8",
  );
  return proj;
}

interface GateAuditRow {
  timestamp: string;
  event:
    | "WORKFLOW_STARTED"
    | "STAGE_JUMPED"
    | "STAGE_STARTED"
    | "STAGE_AWAITING_APPROVAL"
    | "GATE_APPROVED";
  recovered?: boolean;
  revalidated?: boolean;
  stage?: string | null;
}

function seedAudit(
  proj: string,
  rows: GateAuditRow[],
  shardName?: string,
): void {
  const shard = shardName
    ? join(seededAuditDir(proj), shardName)
    : seededAuditShard(proj);
  mkdirSync(join(shard, ".."), { recursive: true });
  const body = rows.map((row) => {
    const stage = row.stage === undefined ? "feasibility" : row.stage;
    return [
      "## Gate Event",
      `**Timestamp**: ${row.timestamp}`,
      `**Event**: ${row.event}`,
      ...(stage === null ? [] : [`**Stage**: ${stage}`]),
      ...(row.recovered ? ["**Recovered**: true"] : []),
      ...(row.revalidated ? ["**Revalidated**: true"] : []),
    ].join("\n");
  }).join("\n\n---\n\n");
  writeFileSync(shard, `${body}\n`, "utf-8");
}

function runDoctor(proj: string): { status: number; out: string } {
  const res = spawnSync(BUN, [UTIL, "doctor", "--verbose", "--project-dir", proj], {
    encoding: "utf-8",
    env: { ...process.env },
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

describe("t317 doctor gate-pending advisory", () => {
  test("stale organic gate renders an advisory PASS without changing exit code", () => {
    const baseline = projectAtGate();
    const baselineRun = runDoctor(baseline);

    const stale = projectAtGate();
    seedAudit(stale, [{
      timestamp: new Date(
        Date.now() - GATE_PENDING_ADVISORY_MS - 2 * 60 * 60 * 1000,
      ).toISOString(),
      event: "STAGE_AWAITING_APPROVAL",
    }]);
    const staleRun = runDoctor(stale);

    expect(staleRun.out).toMatch(
      /ok\s+Approval gate pending: Feasibility & Constraints \(~\d+h\); waiting for a human, not stuck\./,
    );
    expect(staleRun.out).toContain("/aidlc --status");
    expect(staleRun.status).toBe(baselineRun.status);
  });

  test("fresh organic gate is silent", () => {
    const proj = projectAtGate();
    seedAudit(proj, [{
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      event: "STAGE_AWAITING_APPROVAL",
    }]);
    expect(runDoctor(proj).out).not.toContain("Approval gate pending");
  });

  test("no organic pending gate is silent", () => {
    const noLedger = projectAtGate();
    expect(runDoctor(noLedger).out).not.toContain("Approval gate pending");

    const resolved = projectAtGate();
    seedAudit(resolved, [
      {
        timestamp: new Date(
          Date.now() - GATE_PENDING_ADVISORY_MS - 2 * 60 * 60 * 1000,
        ).toISOString(),
        event: "STAGE_AWAITING_APPROVAL",
      },
      {
        timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        event: "GATE_APPROVED",
      },
    ]);
    expect(runDoctor(resolved).out).not.toContain("Approval gate pending");

    const recovered = projectAtGate();
    seedAudit(recovered, [{
      timestamp: new Date(
        Date.now() - GATE_PENDING_ADVISORY_MS - 2 * 60 * 60 * 1000,
      ).toISOString(),
      event: "STAGE_AWAITING_APPROVAL",
      recovered: true,
    }]);
    expect(runDoctor(recovered).out).not.toContain("Approval gate pending");
  });

  test("prior-attempt organic gate does not create a current advisory", () => {
    const proj = projectAtGate();
    const now = Date.now();
    seedAudit(proj, [
      {
        timestamp: new Date(
          now - GATE_PENDING_ADVISORY_MS - 3 * 60 * 60 * 1000,
        ).toISOString(),
        event: "STAGE_AWAITING_APPROVAL",
      },
      {
        timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        event: "STAGE_JUMPED",
        stage: null,
      },
      {
        timestamp: new Date(now - 90 * 60 * 1000).toISOString(),
        event: "STAGE_STARTED",
      },
      {
        timestamp: new Date(now - 60 * 60 * 1000).toISOString(),
        event: "STAGE_AWAITING_APPROVAL",
        recovered: true,
      },
    ]);
    expect(runDoctor(proj).out).not.toContain("Approval gate pending");
  });

  test("revalidation preserves the stale organic gate advisory", () => {
    const proj = projectAtGate();
    const now = Date.now();
    seedAudit(proj, [
      {
        timestamp: new Date(
          now - GATE_PENDING_ADVISORY_MS - 2 * 60 * 60 * 1000,
        ).toISOString(),
        event: "STAGE_AWAITING_APPROVAL",
      },
      {
        timestamp: new Date(now - 60 * 60 * 1000).toISOString(),
        event: "STAGE_AWAITING_APPROVAL",
        revalidated: true,
      },
    ]);
    expect(runDoctor(proj).out).toContain(
      "Approval gate pending: Feasibility & Constraints",
    );
  });

  test("same-second cross-shard boundary and gate omit the advisory", () => {
    const permutations = [
      ["a-boundary.md", "z-gate.md"],
      ["z-boundary.md", "a-gate.md"],
    ] as const;
    for (const [boundaryShard, gateShard] of permutations) {
      const proj = projectAtGate();
      const timestamp = new Date(
        Date.now() - GATE_PENDING_ADVISORY_MS - 2 * 60 * 60 * 1000,
      ).toISOString();
      seedAudit(proj, [{
        timestamp,
        event: "STAGE_STARTED",
      }], boundaryShard);
      seedAudit(proj, [{
        timestamp,
        event: "STAGE_AWAITING_APPROVAL",
      }], gateShard);

      expect(runDoctor(proj).out).not.toContain("Approval gate pending");
    }
  });
});
