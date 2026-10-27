// covers: file:core/tools/aidlc-tiers.ts file:core/tools/aidlc-model-policy.ts
//
// t-exec-devin-subagent-model.serial.test.ts — the live guard for the tier
// table's `devin: { model: "inherit" }` projection. `inherit` is measured,
// undocumented host behavior (the same path an unrecognized `model:` value
// takes on 3000.11.92): a profile WITHOUT `model:` runs the organization's
// default subagent model, `inherit` follows the parent's model, and a full
// model id pins the subagent off the session. This test re-measures that on
// the installed CLI, so a host change that breaks `inherit` fails loudly.
//
// Method: a scratch git project carries two custom profiles, `probe-inherit`
// (model: inherit) and `probe-pinned` (a full model id). `devin -p` asks the
// model to dispatch each in the foreground with a verbatim reply marker.
// Ground truth is `metadata.generation_model` on the assistant messages of
// each subagent chain, read from Devin's own sessions.db (the parent-chain
// heads live in `subagent_heads`; a chain is walked via
// message_nodes.parent_node_id).
//
// LIVE GATE: requires AIDLC_DEVIN_EXEC_LIVE=1 + a devin binary
// (AIDLC_DEVIN_BIN or PATH) + the sessions.db (AIDLC_DEVIN_SESSIONS_DB or
// ~/.local/share/devin/cli/sessions.db). Skips cleanly otherwise.
// Parent/pinned ids overridable via AIDLC_DEVIN_PROBE_PARENT_MODEL /
// AIDLC_DEVIN_PROBE_PINNED_MODEL.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareTriples,
  DEVIN_MIN_VERSION,
  DEVIN_MIN_VERSION_STRING,
  parseVersionTriple,
} from "../../core/tools/aidlc-devin-version.ts";

const DEVIN_BIN = process.env.AIDLC_DEVIN_BIN ?? "devin";
const PARENT_MODEL = process.env.AIDLC_DEVIN_PROBE_PARENT_MODEL ?? "gpt-6-luna-low";
const PINNED_MODEL = process.env.AIDLC_DEVIN_PROBE_PINNED_MODEL ?? "gemini-3-8-flash-low";
const SESSIONS_DB =
  process.env.AIDLC_DEVIN_SESSIONS_DB ??
  join(homedir(), ".local", "share", "devin", "cli", "sessions.db");

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;

function devinVersionOk(): boolean {
  const r = spawnSync(DEVIN_BIN, ["--version"], { encoding: "utf-8" });
  const version = parseVersionTriple(r.stdout ?? "");
  return r.status === 0 && version !== null &&
    compareTriples(version, DEVIN_MIN_VERSION) >= 0;
}

function skipReason(): string | null {
  if (process.env.AIDLC_DEVIN_EXEC_LIVE !== "1") {
    return "set AIDLC_DEVIN_EXEC_LIVE=1 to run the live devin subagent-model probe";
  }
  if (!devinVersionOk()) {
    return `devin >= ${DEVIN_MIN_VERSION_STRING} not found (AIDLC_DEVIN_BIN=${DEVIN_BIN})`;
  }
  if (!existsSync(SESSIONS_DB)) return `sessions.db not found at ${SESSIONS_DB}`;
  return null;
}
const SKIP_REASON = skipReason();

const PROFILES: ReadonlyArray<{ name: string; model: string }> = [
  { name: "probe-inherit", model: "inherit" },
  { name: "probe-pinned", model: PINNED_MODEL },
];

function profileFile(name: string, model: string): string {
  return `---\nname: ${name}\ndescription: >\n  Model-resolution probe profile.\nmodel: ${model}\n---\n\n# ${name}\n\nYou are a probe. Reply verbatim with the requested marker and nothing else.\n`;
}

// Read one Devin session's subagent chains out of sessions.db: for each
// recorded subagent head, walk the message_nodes parent chain collecting the
// generation_model of every assistant message and any PROBE marker in the
// message contents.
function sessionProbeModels(
  projectDir: string,
): Map<string, Set<string>> {
  const db = new Database(SESSIONS_DB, { readonly: true });
  try {
    const sessions = db.query(
      "select id from sessions where working_directory = ? order by created_at desc",
    ).all(realpathSync(projectDir)) as { id: string }[];
    expect(sessions.length, `no devin session recorded for ${projectDir} in ${SESSIONS_DB}`)
      .toBeGreaterThan(0);
    const session = sessions[0]!.id;
    const nodes = new Map<number, { parent: number | null; role: string; model: string | null; content: string }>();
    for (const row of db.query(
      "select node_id, parent_node_id, chat_message from message_nodes where session_id = ?",
    ).all(session) as { node_id: number; parent_node_id: number | null; chat_message: string }[]) {
      const msg = JSON.parse(row.chat_message) as {
        role?: string;
        metadata?: { generation_model?: string };
        content?: unknown;
      };
      nodes.set(row.node_id, {
        parent: row.parent_node_id,
        role: msg.role ?? "",
        model: msg.metadata?.generation_model ?? null,
        content: String(msg.content ?? ""),
      });
    }
    const heads = db.query(
      "select agent_id, chain_node_id from subagent_heads where session_id = ?",
    ).all(session) as { agent_id: string; chain_node_id: number }[];
    const byMarker = new Map<string, Set<string>>();
    for (const head of heads) {
      const models = new Set<string>();
      let marker: string | null = null;
      for (
        let id: number | null = head.chain_node_id;
        id !== null && nodes.has(id);
        id = nodes.get(id)!.parent
      ) {
        const node = nodes.get(id)!;
        if (node.role === "assistant" && node.model) models.add(node.model);
        const m = /PROBE (probe-[a-z]+) OK/.exec(node.content);
        if (m) marker = m[1]!;
      }
      expect(marker, `subagent chain for ${head.agent_id} carried no PROBE marker`).not.toBeNull();
      byMarker.set(marker!, models);
    }
    return byMarker;
  } finally {
    db.close();
  }
}

describe("t-exec-devin-subagent-model — profile model: resolution measured from sessions.db", () => {
  test.skipIf(SKIP_REASON !== null)(
    `model: inherit follows the parent, a pinned id holds${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const root = mkdtempSync(join(tmpdir(), "devin-model-probe-"));
      const proj = join(root, "proj");
      try {
        mkdirSync(join(proj, ".devin", "agents"), { recursive: true });
        for (const profile of PROFILES) {
          writeFileSync(
            join(proj, ".devin", "agents", `${profile.name}.md`),
            profileFile(profile.name, profile.model),
          );
        }
        // Devin resolves project context from the git root, same as every
        // harness — a scratch install needs it.
        expect(spawnSync("git", ["init"], { cwd: proj }).status).toBe(0);

        const prompt =
          `Run each of these, one after the other, exactly as written. ` +
          `Call run_subagent in the foreground (is_background: false) with profile "probe-inherit" and task text "Reply verbatim: PROBE probe-inherit OK". ` +
          `Then call run_subagent in the foreground with profile "probe-pinned" and task text "Reply verbatim: PROBE probe-pinned OK". ` +
          `Finally reply with the two markers you got back, one per line.`;
        const result = spawnSync(
          DEVIN_BIN,
          [
            "-p",
            prompt,
            "--model",
            PARENT_MODEL,
            "--respect-workspace-trust",
            "false",
            "--permission-mode",
            "dangerous",
          ],
          {
            cwd: proj,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PWD: proj },
            timeout: TEST_TIMEOUT_MS,
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

        const measured = sessionProbeModels(proj);
        expect(measured.get("probe-inherit"), "probe-inherit chain").toEqual(
          new Set([PARENT_MODEL]),
        );
        expect(measured.get("probe-pinned"), "probe-pinned chain").toEqual(
          new Set([PINNED_MODEL]),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
