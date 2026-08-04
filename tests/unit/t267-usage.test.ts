// covers: function:sessionsDir, function:modelRatesPath,
// covers: function:DEFAULT_RATES, function:loadRates, function:normalizeModel,
// covers: function:computeCost, function:readClaudeTranscript,
// covers: function:subagentDir, function:readClaudeSession,
// covers: function:dedupeByMessageId, function:readTranscript,
// covers: function:attributeAgents, function:buildAgentTypeMapFromParent,
// covers: function:ledgerPath, function:loadLedger, function:updateLedger,
// covers: function:stageUsageAuditFields, function:writeCurrentTranscriptPath,
// covers: function:readCurrentTranscriptPath, function:foldTranscriptIntoLedger,
// covers: function:workflowUsageAuditFields, function:sessionUsageAggregate
// covers: hook:aidlc-fold-usage
//
// t267-usage - the token-usage seam (aidlc-usage.ts): rate math (framework
// public-list defaults + the AIDLC_MODEL_RATES override), transcript extraction
// (main + sub-agent files), the per-file-cursor ledger, agent-type attribution,
// the audit-rollup field formatter, and the persisted-transcript-path + fold
// helpers.
//
// Everything here is deterministic and fixture-based - zero tokens, zero
// network. Most tests import the shipped modules in-process; the hook-routing and
// cross-process lock regressions spawn local bun processes. Fixtures are
// hand-authored minimal JSONL (no real transcript content) written into a temp
// project tree whose ledger lands at <tmp>/aidlc/.aidlc-sessions/usage-ledger.json.
//
// MECHANISM. In-process imports from the shipped dist tree (the `none` floor for
// pure lib fns). The lib re-exports this file exercises transitively -
// sessionsDir (used by every ledger/transcript-path call) - reddens the
// round-trip/fold assertions on a regression; modelRatesPath is exercised by the
// AIDLC_MODEL_RATES override test below.

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributeAgents,
  buildAgentTypeMapFromParent,
  computeCost,
  dedupeByMessageId,
  foldTranscriptIntoLedger,
  ledgerPath,
  loadLedger,
  loadRates,
  normalizeModel,
  readClaudeSession,
  readClaudeTranscript,
  readCurrentTranscriptPath,
  readTranscript,
  sessionUsageAggregate,
  stageUsageAuditFields,
  updateLedger,
  workflowUsageAuditFields,
  writeCurrentTranscriptPath,
  _resetRatesCacheForTest,
  type TokenCounts,
  type UsageRow,
} from "../../dist/claude/.claude/tools/aidlc-usage.ts";

const tempDirs: string[] = [];
function mkProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-usage-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  // Reset the rate-table cache in case a test mutated AIDLC_MODEL_RATES.
  delete process.env.AIDLC_MODEL_RATES;
  _resetRatesCacheForTest();
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
});

// A convenience: build a minimal Claude assistant JSONL line. Pass `msgId` to
// set the `message.id` (the split-line group key); omit it (the default) to
// produce an id-less line that dedupeByMessageId never merges - preserving the
// one-row-per-line behaviour the hand-authored fixtures rely on.
function assistantLine(o: {
  uuid: string;
  timestamp: string;
  model: string;
  input?: number;
  output?: number;
  cache5m?: number;
  cache1h?: number;
  cacheRead?: number;
  isSidechain?: boolean;
  agentId?: string;
  msgId?: string;
}): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    model: o.model,
    usage: {
      input_tokens: o.input ?? 0,
      output_tokens: o.output ?? 0,
      cache_creation_input_tokens: (o.cache5m ?? 0) + (o.cache1h ?? 0),
      cache_read_input_tokens: o.cacheRead ?? 0,
      cache_creation: {
        ephemeral_5m_input_tokens: o.cache5m ?? 0,
        ephemeral_1h_input_tokens: o.cache1h ?? 0,
      },
    },
  };
  if (o.msgId) message.id = o.msgId;
  const line: Record<string, unknown> = {
    uuid: o.uuid,
    timestamp: o.timestamp,
    isSidechain: o.isSidechain ?? false,
    type: "assistant",
    message,
  };
  if (o.agentId) line.agentId = o.agentId;
  return JSON.stringify(line);
}

const zeroCounts: TokenCounts = {
  input: 0,
  output: 0,
  cacheCreate5m: 0,
  cacheCreate1h: 0,
  cacheRead: 0,
};

// ===========================================================================
// Task 1 - rate table + cost math
// ===========================================================================

describe("Task 1 - normalizeModel + computeCost", () => {
  test("normalizeModel resolves the real Bedrock forms", () => {
    expect(normalizeModel("converse/us.anthropic.claude-opus-4-8")).toBe("opus-4-8");
    expect(normalizeModel("us.anthropic.claude-opus-4-8")).toBe("opus-4-8");
    expect(normalizeModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
    expect(
      normalizeModel("converse/au.anthropic.claude-haiku-4-5-20251001-v1:0"),
    ).toBe("haiku-4-5");
    expect(normalizeModel("converse/au.anthropic.claude-sonnet-4-6")).toBe(
      "sonnet-4-6",
    );
    expect(normalizeModel("opus")).toBe("opus-4-8");
    expect(normalizeModel("sonnet")).toBe("sonnet-4-6");
    expect(normalizeModel("haiku")).toBe("haiku-4-5");
  });

  test("normalizeModel wildcards the region prefix", () => {
    // A never-before-seen region segment must still normalise - the wildcard
    // covers eu/apac/global and any FUTURE region, not a fixed enum.
    expect(normalizeModel("converse/xx.anthropic.claude-opus-4-8")).toBe("opus-4-8");
    expect(normalizeModel("eu.anthropic.claude-sonnet-4-6")).toBe("sonnet-4-6");
    expect(normalizeModel("apac.anthropic.claude-haiku-4-5")).toBe("haiku-4-5");
    expect(normalizeModel("mars-1.anthropic.claude-opus-4-8")).toBe("opus-4-8");
    // The global.anthropic. prefix this harness's settings alias uses.
    expect(normalizeModel("global.anthropic.claude-opus-4-8[1m]")).toBe("opus-4-8");
    // The `.anthropic.` anchor must NOT let the wildcard eat a region-less model.
    expect(normalizeModel("claude-opus-4-8")).toBe("opus-4-8");
    expect(normalizeModel("opus")).toBe("opus-4-8");
    // `<synthetic>` still null under the wildcard.
    expect(normalizeModel("<synthetic>")).toBeNull();
  });

  test("normalizeModel is GENERATION-aware, not family-collapse", () => {
    // Each generation resolves to its OWN discrete key - the old
    // includes("opus") collapse would wrongly map every one to opus-4-8.
    expect(normalizeModel("converse/us.anthropic.claude-opus-5")).toBe("opus-5");
    expect(normalizeModel("converse/us.anthropic.claude-opus-4-8")).toBe("opus-4-8");
    expect(normalizeModel("converse/us.anthropic.claude-opus-4-7")).toBe("opus-4-7");
    expect(normalizeModel("converse/au.anthropic.claude-opus-4-6-v1")).toBe("opus-4-6");
    expect(normalizeModel("converse/au.anthropic.claude-sonnet-4-6")).toBe("sonnet-4-6");
    expect(normalizeModel("converse/us.anthropic.claude-sonnet-5")).toBe("sonnet-5");
    expect(normalizeModel("claude-fable-5")).toBe("fable-5");
    expect(normalizeModel("fable")).toBe("fable-5");
    // sonnet-4-5 must NOT collide with the sonnet-5 needle (it is unpriced =>
    // null, an honest unknown generation, not a mis-price onto sonnet-5).
    expect(normalizeModel("converse/us.anthropic.claude-sonnet-4-5")).toBeNull();
  });

  test("normalizeModel returns null for an UNKNOWN generation", () => {
    // A future generation not in the table must return null - tokens recorded,
    // cost withheld - NOT silently priced at an old generation's rate.
    expect(normalizeModel("converse/us.anthropic.claude-opus-6")).toBeNull();
    expect(normalizeModel("claude-opus-9-9")).toBeNull();
    expect(normalizeModel("opus-6")).toBeNull(); // bare alias must not match opus
  });

  test("normalizeModel requires Claude/provider and generation-token boundaries", () => {
    expect(normalizeModel("claude-opus-4-80")).toBeNull();
    expect(normalizeModel("claude-sonnet-4-60")).toBeNull();
    expect(normalizeModel("notclaude-opus-4-8")).toBeNull();
    expect(normalizeModel("converse/opus-4-8")).toBeNull();
    expect(normalizeModel("anthropic.opus-4-8")).toBeNull();
  });

  test("normalizeModel returns null for unknown / synthetic / empty", () => {
    expect(normalizeModel("<synthetic>")).toBeNull();
    expect(normalizeModel("gpt-4o")).toBeNull();
    expect(normalizeModel("")).toBeNull();
  });

  test("computeCost - known model, exact hand-computed USD (public list prices)", () => {
    // opus-4-8 rates: input 5, output 25, cw5m 6.25, cw1h 10, cr 0.5 /1e6.
    // 1_000_000 input  -> 5.0
    // 2_000_000 output -> 50.0
    // 1_000_000 cw5m   -> 6.25
    // 1_000_000 cw1h   -> 10.0
    // 1_000_000 cr     -> 0.5
    // total = 71.75
    const counts: TokenCounts = {
      input: 1_000_000,
      output: 2_000_000,
      cacheCreate5m: 1_000_000,
      cacheCreate1h: 1_000_000,
      cacheRead: 1_000_000,
    };
    const { usd, model } = computeCost(counts, "converse/us.anthropic.claude-opus-4-8");
    expect(model).toBe("opus-4-8");
    expect(usd).toBeCloseTo(71.75, 6);
  });

  test("computeCost - each generation prices on its OWN key", () => {
    const oneM: TokenCounts = {
      input: 1_000_000,
      output: 1_000_000,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: 0,
    };
    // opus-5: 1e6*5 + 1e6*25 = 30.0
    const o5 = computeCost(oneM, "converse/us.anthropic.claude-opus-5");
    expect(o5.model).toBe("opus-5");
    expect(o5.usd).toBeCloseTo(30.0, 6);
    // opus-4-6 (== opus-4-8): same 30.0, but its OWN key.
    const o46 = computeCost(oneM, "converse/au.anthropic.claude-opus-4-6-v1");
    expect(o46.model).toBe("opus-4-6");
    expect(o46.usd).toBeCloseTo(30.0, 6);
    // sonnet-5: 1e6*3 + 1e6*15 = 18.0
    const s5 = computeCost(oneM, "converse/us.anthropic.claude-sonnet-5");
    expect(s5.model).toBe("sonnet-5");
    expect(s5.usd).toBeCloseTo(18.0, 6);
    // fable-5: 1e6*10 + 1e6*50 = 60.0
    const f5 = computeCost(oneM, "claude-fable-5");
    expect(f5.model).toBe("fable-5");
    expect(f5.usd).toBeCloseTo(60.0, 6);
  });

  test("computeCost - an UNKNOWN generation => usd null (NOT priced as opus-4-8)", () => {
    const counts: TokenCounts = {
      input: 1_000_000,
      output: 0,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: 0,
    };
    const { usd, model } = computeCost(counts, "converse/us.anthropic.claude-opus-6");
    expect(usd).toBeNull();
    expect(model).toBeNull();
  });

  test("computeCost - small realistic bundle for sonnet-4-6", () => {
    // 500 in, 1500 out, 2000 cache-read.
    // 500/1e6*3 + 1500/1e6*15 + 2000/1e6*0.3
    //  = 0.0015 + 0.0225 + 0.0006 = 0.0246
    const counts: TokenCounts = {
      input: 500,
      output: 1500,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: 2000,
    };
    const { usd } = computeCost(counts, "claude-sonnet-4-6");
    expect(usd).toBeCloseTo(0.0246, 8);
  });

  test("computeCost - unknown model => usd null, tokens preserved by caller", () => {
    const counts: TokenCounts = {
      input: 123,
      output: 456,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: 0,
    };
    const { usd, model } = computeCost(counts, "gpt-4o");
    expect(usd).toBeNull();
    expect(model).toBeNull();
    expect(counts.input).toBe(123);
    expect(counts.output).toBe(456);
  });

  test("AIDLC_MODEL_RATES override layers ON TOP of the shipped defaults", () => {
    // Write an override file that redefines opus-4-8 and adds a brand-new
    // generation key. The default sonnet-4-6 must survive (partial overlay), and
    // computeCost must price both the redefined and the new model.
    const dir = mkProject();
    const ratesFile = join(dir, "override-rates.json");
    writeFileSync(
      ratesFile,
      JSON.stringify({
        rates: {
          // Redefine opus-4-8 to a cheaper rate.
          "opus-4-8": { input: 1.0, output: 2.0, cacheWrite5m: 1.25, cacheWrite1h: 2.0, cacheRead: 0.1 },
          "opus-6": { input: 7.0, output: 35.0, cacheWrite5m: 8.75, cacheWrite1h: 14.0, cacheRead: 0.7 },
        },
      }),
    );
    process.env.AIDLC_MODEL_RATES = ratesFile;
    _resetRatesCacheForTest();
    const rates = loadRates();
    // Overlaid opus-4-8.
    expect(rates["opus-4-8"].input).toBe(1.0);
    // Default sonnet-4-6 survives (not named in the override).
    expect(rates["sonnet-4-6"].input).toBe(3.0);
    // computeCost uses the overlaid rate: 1e6 input opus at 1.0 = 1.00.
    const { usd } = computeCost(
      { input: 1_000_000, output: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 },
      "converse/us.anthropic.claude-opus-4-8",
    );
    expect(usd).toBeCloseTo(1.0, 6);
    const next = computeCost(
      { input: 1_000_000, output: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 },
      "claude-opus-6",
    );
    expect(next.model).toBe("opus-6");
    expect(next.usd).toBeCloseTo(7.0, 6);
    // Override keys name Claude generations, not arbitrary provider/model IDs.
    expect(normalizeModel("converse/opus-6")).toBeNull();
  });

  test("AIDLC_MODEL_RATES: a malformed override file leaves the defaults intact", () => {
    const dir = mkProject();
    const ratesFile = join(dir, "bad-rates.json");
    writeFileSync(ratesFile, "{ not valid json ]");
    process.env.AIDLC_MODEL_RATES = ratesFile;
    _resetRatesCacheForTest();
    const rates = loadRates();
    // The shipped default still stands.
    expect(rates["opus-4-8"].input).toBe(5.0);
  });
});

// ===========================================================================
// Task 2 - transcript extraction
// ===========================================================================

describe("Task 2 - Claude extraction (main + sub-agents)", () => {
  test("readClaudeTranscript parses assistant usage rows; splits cache TTLs", () => {
    const dir = mkProject();
    const p = join(dir, "main.jsonl");
    writeFileSync(
      p,
      [
        // a non-assistant line (user) - must be skipped
        JSON.stringify({ uuid: "u0", type: "user", message: { role: "user" } }),
        assistantLine({
          uuid: "u1",
          timestamp: "2026-07-23T04:00:00.000Z",
          model: "converse/us.anthropic.claude-opus-4-8",
          input: 10,
          output: 20,
          cache5m: 5,
          cache1h: 7,
          cacheRead: 3,
        }),
      ].join("\n"),
    );
    const rows = readClaudeTranscript(p);
    expect(rows.length).toBe(1);
    expect(rows[0].uuid).toBe("u1");
    expect(rows[0].sourceKey).toBe("main");
    expect(rows[0].agentId).toBeNull();
    expect(rows[0].counts).toEqual({
      input: 10,
      output: 20,
      cacheCreate5m: 5,
      cacheCreate1h: 7,
      cacheRead: 3,
    });
    expect(rows[0].usd).not.toBeNull();
  });

  test("readClaudeTranscript falls back to flat cache total as 5m when split absent", () => {
    const dir = mkProject();
    const p = join(dir, "main.jsonl");
    writeFileSync(
      p,
      JSON.stringify({
        uuid: "u1",
        timestamp: "t",
        type: "assistant",
        message: {
          role: "assistant",
          model: "us.anthropic.claude-opus-4-8",
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 42,
            cache_read_input_tokens: 0,
          },
        },
      }),
    );
    const rows = readClaudeTranscript(p);
    expect(rows[0].counts.cacheCreate5m).toBe(42);
    expect(rows[0].counts.cacheCreate1h).toBe(0);
  });

  test("readClaudeTranscript trusts flat cache total when Bedrock ships a zeroed nested split", () => {
    const dir = mkProject();
    const p = join(dir, "main.jsonl");
    writeFileSync(
      p,
      JSON.stringify({
        uuid: "u1",
        timestamp: "t",
        type: "assistant",
        message: {
          role: "assistant",
          model: "converse/us.anthropic.claude-opus-4-8",
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 79620,
            cache_read_input_tokens: 0,
            cache_creation: {
              ephemeral_5m_input_tokens: 0,
              ephemeral_1h_input_tokens: 0,
            },
          },
        },
      }),
    );
    const rows = readClaudeTranscript(p);
    expect(rows[0].counts.cacheCreate5m).toBe(79620);
    expect(rows[0].counts.cacheCreate1h).toBe(0);
  });

  test("readClaudeSession reads main + subagents/agent-*.jsonl with meta sidecar", () => {
    const dir = mkProject();
    const main = join(dir, "session.jsonl");
    writeFileSync(
      main,
      assistantLine({
        uuid: "m1",
        timestamp: "2026-07-23T04:22:43.957Z",
        model: "converse/us.anthropic.claude-opus-4-8",
        output: 100,
      }),
    );
    const subDir = join(dir, "session", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, "agent-abc123.jsonl"),
      assistantLine({
        uuid: "s1",
        timestamp: "2026-07-23T04:22:43.957Z",
        model: "us.anthropic.claude-haiku-4-5-20251001",
        output: 50,
        isSidechain: true,
        agentId: "abc123",
      }),
    );
    writeFileSync(
      join(subDir, "agent-abc123.meta.json"),
      JSON.stringify({ agentType: "code-reviewer", description: "x" }),
    );
    const rows = readClaudeSession(main);
    expect(rows.length).toBe(2);
    const mainRow = rows.find((r) => r.sourceKey === "main")!;
    const subRow = rows.find((r) => r.sourceKey === "agent-abc123")!;
    expect(mainRow.agentType).toBe("main");
    expect(mainRow.agentId).toBeNull();
    expect(subRow.agentId).toBe("abc123");
    expect(subRow.isSidechain).toBe(true);
    expect(subRow.agentType).toBe("code-reviewer");
  });

  test("malformed JSONL line => good lines parsed, no throw", () => {
    const dir = mkProject();
    const p = join(dir, "main.jsonl");
    writeFileSync(
      p,
      [
        assistantLine({ uuid: "g1", timestamp: "t", model: "opus", output: 1 }),
        "{ this is not valid json",
        assistantLine({ uuid: "g2", timestamp: "t", model: "opus", output: 2 }),
        '{"partial":', // half-written trailing line
      ].join("\n"),
    );
    const rows = readClaudeTranscript(p);
    expect(rows.map((r) => r.uuid)).toEqual(["g1", "g2"]);
  });

  test("missing subagents/ dir => main rows only, no throw", () => {
    const dir = mkProject();
    const main = join(dir, "session.jsonl");
    writeFileSync(
      main,
      assistantLine({ uuid: "m1", timestamp: "t", model: "opus", output: 1 }),
    );
    const rows = readClaudeSession(main);
    expect(rows.length).toBe(1);
    expect(rows[0].sourceKey).toBe("main");
  });

  test("missing file => [] (no throw)", () => {
    expect(readClaudeTranscript("/no/such/file.jsonl")).toEqual([]);
    expect(readTranscript("/no/such/file.jsonl")).toEqual([]);
  });

  test("readTranscript handles Claude; non-Claude / unknown => []", () => {
    const dir = mkProject();
    const claude = join(dir, "c.jsonl");
    writeFileSync(
      claude,
      assistantLine({ uuid: "m1", timestamp: "t", model: "opus", output: 1 }),
    );
    expect(readTranscript(claude).length).toBe(1);

    // A Codex-style response_item/payload-shaped file is not recognised and
    // yields [] (only the Claude Code format is supported).
    const codex = join(dir, "codex.jsonl");
    writeFileSync(
      codex,
      JSON.stringify({
        type: "response_item",
        timestamp: "t",
        payload: {
          model: "gpt-5",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      }),
    );
    expect(readTranscript(codex)).toEqual([]);

    const unknown = join(dir, "u.jsonl");
    writeFileSync(unknown, JSON.stringify({ hello: "world" }));
    expect(readTranscript(unknown)).toEqual([]);
  });
});

// ===========================================================================
// Task 4 - agent-type attribution
// ===========================================================================

describe("Task 4 - attributeAgents + parent-join fallback", () => {
  test("sidecar map wins; main => 'main'; missing => 'subagent'", () => {
    const rows: UsageRow[] = [
      {
        uuid: "m1",
        msgId: "",
        timestamp: "t",
        model: "opus",
        isSidechain: false,
        sourceKey: "main",
        agentId: null,
        agentType: null,
        counts: { ...zeroCounts },
        usd: 0,
      },
      {
        uuid: "s1",
        msgId: "",
        timestamp: "t",
        model: "haiku",
        isSidechain: true,
        sourceKey: "agent-known",
        agentId: "known",
        agentType: null,
        counts: { ...zeroCounts },
        usd: 0,
      },
      {
        uuid: "s2",
        msgId: "",
        timestamp: "t",
        model: "haiku",
        isSidechain: true,
        sourceKey: "agent-orphan",
        agentId: "orphan",
        agentType: null,
        counts: { ...zeroCounts },
        usd: 0,
      },
    ];
    attributeAgents(rows, { known: "Explore" });
    expect(rows[0].agentType).toBe("main");
    expect(rows[1].agentType).toBe("Explore");
    expect(rows[2].agentType).toBe("subagent");
  });

  test("buildAgentTypeMapFromParent joins tool_use_id -> agentId -> subagent_type", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tooluse_1",
              name: "Task",
              input: { subagent_type: "code-reviewer" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        tool_use_id: "tooluse_1",
        toolUseResult: { agentId: "hexid42" },
      }),
    ];
    const map = buildAgentTypeMapFromParent(lines);
    expect(map).toEqual({ hexid42: "code-reviewer" });
  });
});

// ===========================================================================
// Task 3 - per-file cursor ledger
// ===========================================================================

describe("Task 3 - updateLedger per-file cursors", () => {
  test("fold across main + 2 sub-agents; re-fold is idempotent", () => {
    const dir = mkProject();
    const rows: UsageRow[] = [
      row("m1", "main", "opus", { output: 100 }),
      row("a1", "agent-a", "haiku", { output: 10, agentId: "a" }),
      row("b1", "agent-b", "sonnet", { output: 20, agentId: "b" }),
    ];
    const first = updateLedger(dir, rows, "stage-x");
    const out1 = first.totals.tokens.output;
    expect(out1).toBe(130);
    expect(first.byStage["stage-x"].totals.tokens.output).toBe(130);
    // Re-fold the exact same rows => no double count.
    const second = updateLedger(dir, rows, "stage-x");
    expect(second.totals.tokens.output).toBe(130);
    expect(second.byStage["stage-x"].totals.tokens.output).toBe(130);
  });

  test("append: a second batch appends new rows to one file, only they count", () => {
    const dir = mkProject();
    updateLedger(dir, [row("m1", "main", "opus", { output: 100 })], null);
    // Batch 2: same file key, cursor present; m1 already seen, m2 is new.
    const led = updateLedger(
      dir,
      [
        row("m1", "main", "opus", { output: 100 }),
        row("m2", "main", "opus", { output: 5 }),
      ],
      null,
    );
    expect(led.totals.tokens.output).toBe(105);
  });

  test("uuid-collision: same uuid in two files, one copy 232 the other 0 => total 232, both counted, not deduped, not dropped", () => {
    const dir = mkProject();
    // The regression that proves the global-uuid design was wrong. A broadcast
    // turn shares uuid "dup" across two concurrent sub-agent files; only one
    // copy carries the real output_tokens.
    const rows: UsageRow[] = [
      row("dup", "agent-a", "opus", { output: 232, agentId: "a" }),
      row("dup", "agent-b", "opus", { output: 0, agentId: "b" }),
    ];
    const led = updateLedger(dir, rows, null);
    expect(led.totals.tokens.output).toBe(232);
    // Both files got their own cursor advanced to uuid "dup" - not merged.
    expect(led.cursors["agent-a"].lastUuid).toBe("dup");
    expect(led.cursors["agent-b"].lastUuid).toBe("dup");
    // Re-fold: still 232, no double-count.
    const again = updateLedger(dir, rows, null);
    expect(again.totals.tokens.output).toBe(232);
  });

  test("corrupt ledger on disk => loadLedger empty, updateLedger still succeeds", () => {
    const dir = mkProject();
    mkdirSync(join(dir, "aidlc", ".aidlc-sessions"), { recursive: true });
    writeFileSync(ledgerPath(dir), "{ not json ]");
    const led = loadLedger(dir);
    expect(led.totals.tokens.output).toBe(0);
    expect(led.cursors).toEqual({});
    const updated = updateLedger(dir, [row("m1", "main", "opus", { output: 7 })], null);
    expect(updated.totals.tokens.output).toBe(7);
  });

  test("byModel keeps unknown-model tokens with no cost", () => {
    const dir = mkProject();
    const led = updateLedger(
      dir,
      [row("x1", "main", "gpt-4o", { output: 99 })],
      null,
    );
    // unknown model => bucketed under raw name, usd stays 0
    expect(led.byModel["gpt-4o"].tokens.output).toBe(99);
    expect(led.byModel["gpt-4o"].usd).toBe(0);
  });

  test("workflow and session aggregates stay isolated", () => {
    const dir = mkProject();
    updateLedger(
      dir,
      [row("a1", "main-a", "opus", { output: 10 })],
      "intent-capture",
      { workflowKey: "intent:a", sessionKey: "transcript:/a.jsonl" },
    );
    updateLedger(
      dir,
      [row("b1", "main-b", "opus", { output: 20 })],
      "intent-capture",
      { workflowKey: "intent:b", sessionKey: "transcript:/b.jsonl" },
    );

    expect(
      stageUsageAuditFields(dir, "intent-capture", "intent:a")["Tokens Out"],
    ).toBe("10");
    expect(
      stageUsageAuditFields(dir, "intent-capture", "intent:b")["Tokens Out"],
    ).toBe("20");
    expect(
      sessionUsageAggregate(dir, "/a.jsonl", "intent:a")?.totals.tokens.output,
    ).toBe(10);
    expect(
      sessionUsageAggregate(dir, "/b.jsonl", "intent:b")?.totals.tokens.output,
    ).toBe(20);
  });
});

// Helper: build a UsageRow with computed usd, for ledger tests. `msgId` defaults
// to "" (id-less => never merged by dedupeByMessageId), so existing ledger tests
// keep their one-row-per-row semantics; pass `o.msgId` to exercise dedup.
function row(
  uuid: string,
  sourceKey: string,
  model: string,
  o: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreate5m?: number;
    agentId?: string;
    msgId?: string;
  },
): UsageRow {
  const counts: TokenCounts = {
    input: o.input ?? 0,
    output: o.output ?? 0,
    cacheCreate5m: o.cacheCreate5m ?? 0,
    cacheCreate1h: 0,
    cacheRead: o.cacheRead ?? 0,
  };
  return {
    uuid,
    msgId: o.msgId ?? "",
    timestamp: "2026-07-23T04:22:43.957Z",
    model,
    isSidechain: sourceKey !== "main",
    sourceKey,
    agentId: o.agentId ?? null,
    agentType: sourceKey === "main" ? "main" : "subagent",
    counts,
    usd: computeCost(counts, model).usd,
  };
}

// ===========================================================================
// Task 5 - audit rollup fields (usage.ts half; ledger read only)
// ===========================================================================

describe("Task 5 - stageUsageAuditFields", () => {
  test("known-model stage => expected field strings incl. Cost USD + token breakdowns", () => {
    const dir = mkProject();
    updateLedger(
      dir,
      [row("m1", "main", "converse/us.anthropic.claude-opus-4-8", { input: 1_000_000, output: 0 })],
      "stage-x",
    );
    const fields = stageUsageAuditFields(dir, "stage-x");
    expect(fields["Tokens In"]).toBe("1000000");
    expect(fields["Tokens Out"]).toBe("0");
    expect(fields["Cache Write"]).toBe("0");
    // 1e6 input at opus 5/1e6 = 5.00
    expect(fields["Cost USD"]).toBe("5.00");
    expect(fields["By Model"]).toContain("opus-4-8=5.00");
    expect(fields["By Agent"]).toContain("main=5.00");
    // token counts grouped by model AND agent (input/output/cacheRead/cacheWrite).
    expect(fields["Tokens By Model"]).toBe("opus-4-8=1M/0/0/0");
    expect(fields["Tokens By Agent"]).toBe("main=1M/0/0/0");
  });

  test("cache-write tokens surface as Cache Write + the 4th quad slot", () => {
    const dir = mkProject();
    updateLedger(
      dir,
      [
        row("m1", "main", "converse/us.anthropic.claude-opus-4-8", {
          input: 1000,
          output: 200,
          cacheRead: 2000,
          cacheCreate5m: 79_600,
        }),
      ],
      "stage-cw",
    );
    const fields = stageUsageAuditFields(dir, "stage-cw");
    expect(fields["Cache Read"]).toBe("2000");
    expect(fields["Cache Write"]).toBe("79600");
    // Quad order input/output/cacheRead/cacheWrite; 79_600 -> compact 79.6k.
    expect(fields["Tokens By Model"]).toBe("opus-4-8=1k/200/2k/79.6k");
    expect(fields["Tokens By Agent"]).toBe("main=1k/200/2k/79.6k");
  });

  test("unknown-model stage => tokens present, Cost USD: null (not omitted)", () => {
    const dir = mkProject();
    updateLedger(dir, [row("m1", "main", "gpt-4o", { input: 500, output: 700 })], "stage-y");
    const fields = stageUsageAuditFields(dir, "stage-y");
    expect(fields["Tokens In"]).toBe("500");
    expect(fields["Tokens Out"]).toBe("700");
    // Recorded usage but all unknown-model => explicit "null", NOT omitted.
    expect(fields["Cost USD"]).toBe("null");
    // By Model shows the unknown bucket with =null (visible, not dropped).
    expect(fields["By Model"]).toBe("gpt-4o=null");
    // Token breakdown still present for the unknown model.
    expect(fields["Tokens By Model"]).toBe("gpt-4o=500/700/0/0");
  });

  test("mixed known+unknown stage => cost of known portion + unknown visible", () => {
    const dir = mkProject();
    updateLedger(
      dir,
      [
        row("m1", "main", "converse/us.anthropic.claude-opus-4-8", { input: 1_000_000, output: 0 }),
        row("m2", "main", "some-future-model", { input: 2000, output: 0 }),
      ],
      "stage-mix",
    );
    const fields = stageUsageAuditFields(dir, "stage-mix");
    // Cost reflects ONLY the known (opus) portion - 5.00 - never fabricated.
    expect(fields["Cost USD"]).toBe("5.00");
    // By Model prices opus and shows the unknown model as =null.
    expect(fields["By Model"]).toContain("opus-4-8=5.00");
    expect(fields["By Model"]).toContain("some-future-model=null");
  });

  test("absent stage bucket => {} (no fields)", () => {
    const dir = mkProject();
    expect(stageUsageAuditFields(dir, "never-ran")).toEqual({});
  });

  test("multi-stage: By Model / By Agent are STAGE-scoped, not global", () => {
    // Regression for the global-bucket bug: fold stage-A (opus) then stage-B
    // (sonnet) into the SAME ledger. stage-B's rollup must show ONLY sonnet in
    // By Model, and its Cost USD must equal stage-B alone.
    const dir = mkProject();
    updateLedger(
      dir,
      [row("a1", "main", "converse/us.anthropic.claude-opus-4-8", { input: 1_000_000, output: 0 })],
      "stage-A",
    );
    updateLedger(
      dir,
      [row("b1", "main", "converse/au.anthropic.claude-sonnet-4-6", { input: 1_000_000, output: 0 })],
      "stage-B",
    );

    const b = stageUsageAuditFields(dir, "stage-B");
    // sonnet input at 3/1e6 x 1e6 = 3.00
    expect(b["Cost USD"]).toBe("3.00");
    expect(b["By Model"]).toBe("sonnet-4-6=3.00");
    expect(b["By Model"]).not.toContain("opus");
    expect(b["By Agent"]).toBe("main=3.00");

    // stage-A stays opus-only (5.00), likewise not contaminated by stage-B.
    const a = stageUsageAuditFields(dir, "stage-A");
    expect(a["Cost USD"]).toBe("5.00");
    expect(a["By Model"]).toBe("opus-4-8=5.00");
    expect(a["By Model"]).not.toContain("sonnet");
  });

  test("loadLedger tolerates a flat-Totals byStage entry (normalizeByStage coercion) without throwing", () => {
    // normalizeByStage must wrap a flat-Totals byStage[slug] into a StageBucket
    // (empty sub-maps) rather than crash a consumer. Tested on a CURRENT-schema
    // ledger (schemaVersion:3 + a byteOffset cursor) so the migration reset does
    // NOT discard it - the coercion path is what's under test here.
    const dir = mkProject();
    mkdirSync(join(dir, "aidlc", ".aidlc-sessions"), { recursive: true });
    writeFileSync(
      ledgerPath(dir),
      JSON.stringify({
        schemaVersion: 3,
        cursors: { "/x.jsonl": { lastUuid: "u", lastTimestamp: "t", byteOffset: 10 } },
        totals: { tokens: { input: 5, output: 6, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 }, usd: 0 },
        byStage: {},
        byModel: {},
        byAgent: {},
        workflows: {
          "record:default/legacy": {
            totals: { tokens: { input: 5, output: 6, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 }, usd: 0 },
            byStage: {
              "old-stage": {
                tokens: { input: 5, output: 6, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 },
                usd: 0,
              },
            },
            byModel: {},
            byAgent: {},
            sessions: {},
          },
        },
      }),
    );
    const fields = stageUsageAuditFields(dir, "old-stage");
    expect(fields["Tokens In"]).toBe("5");
    expect(fields["Tokens Out"]).toBe("6");
    // No per-model history in the flat shape => By Model omitted, no throw.
    expect(fields["By Model"]).toBeUndefined();
  });

  test("workflow rollup includes all stages, not only the final stage", () => {
    const dir = mkProject();
    const context = {
      workflowKey: "intent:workflow",
      sessionKey: "transcript:/workflow.jsonl",
    };
    updateLedger(
      dir,
      [row("a", "stage-a", "opus", { output: 10 })],
      "stage-a",
      context,
    );
    updateLedger(
      dir,
      [row("b", "stage-b", "opus", { output: 20 })],
      "stage-b",
      context,
    );
    expect(
      stageUsageAuditFields(dir, "stage-b", context.workflowKey)["Tokens Out"],
    ).toBe("20");
    expect(
      workflowUsageAuditFields(dir, context.workflowKey)["Tokens Out"],
    ).toBe("30");
  });
});

// ===========================================================================
// Task 6 - persisted transcript path + fold helper (usage.ts half)
// ===========================================================================

describe("Task 6 - transcript path round-trip + foldTranscriptIntoLedger", () => {
  test("writeCurrentTranscriptPath => readCurrentTranscriptPath round-trips", () => {
    const dir = mkProject();
    writeCurrentTranscriptPath(dir, "sess-1", "/path/to/session.jsonl");
    expect(readCurrentTranscriptPath(dir, "sess-1")).toBe("/path/to/session.jsonl");
    // Falls back to current.transcript when no session id given.
    expect(readCurrentTranscriptPath(dir)).toBe("/path/to/session.jsonl");
    // Absent session id => null.
    expect(readCurrentTranscriptPath(mkProject(), "nope")).toBeNull();
  });

  test("foldTranscriptIntoLedger creates usage-ledger.json with correct totals; idempotent", () => {
    const dir = mkProject();
    const transcript = join(dir, "session.jsonl");
    writeFileSync(
      transcript,
      [
        assistantLine({
          uuid: "m1",
          timestamp: "t",
          model: "converse/us.anthropic.claude-opus-4-8",
          output: 100,
        }),
        assistantLine({
          uuid: "m2",
          timestamp: "t",
          model: "converse/us.anthropic.claude-opus-4-8",
          output: 50,
        }),
        "", // trailing newline - real transcripts are newline-terminated
      ].join("\n"),
    );
    // flush=true => the whole file's groups are complete and counted (the Stop
    // hook's turn-end fold). Both id-less lines are their own groups.
    const led = foldTranscriptIntoLedger(dir, transcript, "stage-z", true);
    expect(existsSync(ledgerPath(dir))).toBe(true);
    expect(led.totals.tokens.output).toBe(150);
    expect(led.byStage["stage-z"].totals.tokens.output).toBe(150);
    // On-disk matches, and the ledger is stamped with the current schema version.
    const onDisk = JSON.parse(readFileSync(ledgerPath(dir), "utf-8"));
    expect(onDisk.totals.tokens.output).toBe(150);
    expect(onDisk.schemaVersion).toBe(3);
    // Second call => idempotent (per-file cursor, keyed by transcript path).
    const again = foldTranscriptIntoLedger(dir, transcript, "stage-z", true);
    expect(again.totals.tokens.output).toBe(150);
  });

  test("foldTranscriptIntoLedger on a missing transcript => no throw, empty ledger", () => {
    const dir = mkProject();
    const led = foldTranscriptIntoLedger(dir, "/no/such/transcript.jsonl", null);
    expect(led.totals.tokens.output).toBe(0);
  });

  test("PreToolUse hook seals the lifecycle call under the current stage", () => {
    const dir = mkProject();
    const stateDir = join(dir, "aidlc", "spaces", "default", "intents");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "aidlc-state.md"),
      "- **Current Stage**: `stage-before-transition`\n",
    );
    const transcript = join(dir, "session.jsonl");
    writeFileSync(
      transcript,
      assistantLine({
        uuid: "pre-hook",
        timestamp: "t",
        model: "opus",
        input: 100,
        msgId: "lifecycle-call",
      }),
    );
    const subDir = join(dir, "session", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, "agent-review.jsonl"),
      assistantLine({
        uuid: "sub-hook",
        timestamp: "t",
        model: "haiku",
        output: 50,
        isSidechain: true,
        agentId: "review",
        msgId: "subagent-final-call",
      }),
    );
    writeFileSync(
      join(subDir, "agent-review.meta.json"),
      JSON.stringify({ agentType: "code-reviewer" }),
    );
    const hook = join(
      import.meta.dir,
      "..",
      "..",
      "dist",
      "claude",
      ".claude",
      "hooks",
      "aidlc-fold-usage.ts",
    );
    const result = Bun.spawnSync([process.execPath, hook], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      stdin: new TextEncoder().encode(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: {
            command:
              "bun .claude/tools/aidlc-orchestrate.ts report --stage stage-before-transition --result completed",
          },
          session_id: "session-pre",
          transcript_path: transcript,
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    const ledger = loadLedger(dir);
    expect(
      ledger.workflows["record:default/legacy"].byStage[
        "stage-before-transition"
      ].totals.tokens.input,
    ).toBe(100);
    expect(
      ledger.workflows["record:default/legacy"].byStage[
        "stage-before-transition"
      ].byAgent["code-reviewer"].tokens.output,
    ).toBe(50);
  });

  test("quoted lifecycle text does not flush an active subagent group", () => {
    const dir = mkProject();
    const stateDir = join(dir, "aidlc", "spaces", "default", "intents");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "aidlc-state.md"),
      "- **Current Stage**: `stage-search`\n",
    );
    const transcript = join(dir, "session.jsonl");
    writeFileSync(
      transcript,
      assistantLine({
        uuid: "main-search",
        timestamp: "t",
        model: "opus",
        input: 100,
        msgId: "main-search-call",
      }),
    );
    const subDir = join(dir, "session", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, "agent-live.jsonl"),
      assistantLine({
        uuid: "sub-live",
        timestamp: "t",
        model: "haiku",
        output: 50,
        isSidechain: true,
        agentId: "live",
        msgId: "subagent-active-call",
      }),
    );
    const hook = join(
      import.meta.dir,
      "..",
      "..",
      "dist",
      "claude",
      ".claude",
      "hooks",
      "aidlc-fold-usage.ts",
    );
    const fire = (command: string) =>
      Bun.spawnSync([process.execPath, hook], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        stdin: new TextEncoder().encode(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command },
            session_id: "session-search",
            transcript_path: transcript,
          }),
        ),
        stdout: "pipe",
        stderr: "pipe",
      });

    const quoted = fire(
      `echo "example; bun .claude/tools/aidlc-orchestrate.ts report --stage stage-search --result completed"`,
    );
    expect(quoted.exitCode).toBe(0);
    const beforeBoundary = loadLedger(dir);
    expect(beforeBoundary.totals.tokens.input).toBe(100);
    expect(beforeBoundary.totals.tokens.output).toBe(0);

    const executableSubstitution = fire(
      `result="$(bun .claude/tools/aidlc-orchestrate.ts report --stage stage-search --result completed)"`,
    );
    expect(executableSubstitution.exitCode).toBe(0);
    expect(loadLedger(dir).totals.tokens.output).toBe(50);
  });
});

// ===========================================================================
// message.id dedup (split-line overcount fix)
// ===========================================================================

describe("dedupeByMessageId / split-line dedup", () => {
  test("3 lines sharing message.id 'm' collapse to ONE row; usage counted once", () => {
    // Claude Code splits one llm call across thinking/text/tool_use lines,
    // stamping the SAME usage on each. All three carry {input:10,output:20}; the
    // row must total 10/20, NOT 30/60.
    const dir = mkProject();
    const p = join(dir, "main.jsonl");
    writeFileSync(
      p,
      [
        assistantLine({ uuid: "u1", timestamp: "t1", model: "opus", input: 10, output: 20, msgId: "m" }),
        assistantLine({ uuid: "u2", timestamp: "t2", model: "opus", input: 10, output: 20, msgId: "m" }),
        assistantLine({ uuid: "u3", timestamp: "t3", model: "opus", input: 10, output: 20, msgId: "m" }),
      ].join("\n"),
    );
    const rows = readClaudeTranscript(p);
    expect(rows.length).toBe(1);
    expect(rows[0].counts.input).toBe(10);
    expect(rows[0].counts.output).toBe(20);
    // Representative row = LAST line of the run (real end-of-turn).
    expect(rows[0].uuid).toBe("u3");
    expect(rows[0].msgId).toBe("m");
  });

  test("id-less fallback: lines without message.id are each counted, never merged", () => {
    const dir = mkProject();
    const p = join(dir, "main.jsonl");
    writeFileSync(
      p,
      [
        assistantLine({ uuid: "a", timestamp: "t", model: "opus", output: 1 }),
        assistantLine({ uuid: "b", timestamp: "t", model: "opus", output: 2 }),
        assistantLine({ uuid: "c", timestamp: "t", model: "opus", output: 3 }),
      ].join("\n"),
    );
    const rows = readClaudeTranscript(p);
    expect(rows.map((r) => r.uuid)).toEqual(["a", "b", "c"]);
    expect(rows.every((r) => r.msgId === "")).toBe(true);
  });

  test("dedupeByMessageId is a pure contiguous-run collapse", () => {
    const rows: UsageRow[] = [
      row("u1", "main", "opus", { output: 20, msgId: "m" }),
      row("u2", "main", "opus", { output: 20, msgId: "m" }),
      row("u3", "main", "opus", { output: 5, msgId: "n" }),
      row("u4", "main", "opus", { output: 7 }), // id-less - its own row
    ];
    const out = dedupeByMessageId(rows);
    expect(out.map((r) => r.uuid)).toEqual(["u2", "u3", "u4"]);
  });

  test("NEW-STYLE dedup: leading usage=0 lines lose to the trailing real-usage line (max-usage representative)", () => {
    const rows: UsageRow[] = [
      row("z-think", "main", "opus", { input: 0, output: 0, msgId: "z" }),
      row("z-text", "main", "opus", { input: 0, output: 0, msgId: "z" }),
      row("z-tool", "main", "opus", { input: 900, output: 42, msgId: "z" }),
    ];
    const out = dedupeByMessageId(rows);
    expect(out.length).toBe(1);
    expect(out[0].counts.input).toBe(900);
    expect(out[0].counts.output).toBe(42);
    expect(out[0].uuid).toBe("z-tool"); // representative = the real-usage line
  });

  test("dedup takes the MAX-usage line even when the real-usage line is not last", () => {
    const rows: UsageRow[] = [
      row("w-think", "main", "opus", { input: 0, output: 0, msgId: "w" }),
      row("w-real", "main", "opus", { input: 500, output: 30, msgId: "w" }),
      row("w-zero", "main", "opus", { input: 0, output: 0, msgId: "w" }),
    ];
    const out = dedupeByMessageId(rows);
    expect(out.length).toBe(1);
    expect(out[0].counts.input).toBe(500);
    expect(out[0].counts.output).toBe(30);
  });

  test("cross-file uuid collision still counted after dedup (per-file invariant)", () => {
    const dir = mkProject();
    const rows: UsageRow[] = [
      row("dup", "agent-a", "opus", { output: 232, agentId: "a", msgId: "ma" }),
      row("dup", "agent-b", "opus", { output: 0, agentId: "b", msgId: "mb" }),
    ];
    const led = updateLedger(dir, rows, null);
    expect(led.totals.tokens.output).toBe(232);
    expect(led.cursors["agent-a"].lastUuid).toBe("dup");
    expect(led.cursors["agent-b"].lastUuid).toBe("dup");
    const again = updateLedger(dir, rows, null);
    expect(again.totals.tokens.output).toBe(232);
  });
});

// ===========================================================================
// byte-offset incremental fold + HOLDBACK model
// ===========================================================================

describe("offset-aware fold, holdback, byteOffset", () => {
  test("HOLDBACK (old-style straddle): message 'm' folded across two calls counts EXACTLY once", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    // Old-style: each split line carries the SAME usage (input:100, output:40).
    writeFileSync(
      p,
      [
        assistantLine({ uuid: "m-think", timestamp: "t1", model: "opus", input: 100, output: 40, msgId: "m" }),
        assistantLine({ uuid: "m-text", timestamp: "t2", model: "opus", input: 100, output: 40, msgId: "m" }),
        "", // trailing newline (chunk ends in \n)
      ].join("\n"),
    );
    const led1 = foldTranscriptIntoLedger(dir, p, "stage-x", false);
    // 'm' is the last (only) group => held back => nothing counted yet.
    expect(led1.totals.tokens.output).toBe(0);
    expect(led1.totals.tokens.input).toBe(0);

    // Append the completing tool_use line for m, then a full group n, and flush.
    appendFileSync(
      p,
      [
        assistantLine({ uuid: "m-tool", timestamp: "t3", model: "opus", input: 100, output: 40, msgId: "m" }),
        assistantLine({ uuid: "n-think", timestamp: "t4", model: "opus", input: 200, output: 60, msgId: "n" }),
        assistantLine({ uuid: "n-text", timestamp: "t5", model: "opus", input: 200, output: 60, msgId: "n" }),
        assistantLine({ uuid: "n-tool", timestamp: "t6", model: "opus", input: 200, output: 60, msgId: "n" }),
        "",
      ].join("\n"),
    );
    const led2 = foldTranscriptIntoLedger(dir, p, "stage-x", true);
    // m counted ONCE (40 out / 100 in), n counted ONCE (60 out / 200 in).
    expect(led2.totals.tokens.output).toBe(40 + 60);
    expect(led2.totals.tokens.input).toBe(100 + 200);
    expect(led2.byStage["stage-x"].totals.tokens.output).toBe(100);
  });

  test("NEW-STYLE straddle: usage=0 leading line then real-usage line across a chunk boundary - no tokens lost", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    writeFileSync(
      p,
      [
        // thinking line - usage all zero
        assistantLine({ uuid: "x-think", timestamp: "t1", model: "opus", input: 0, output: 0, msgId: "x" }),
        "",
      ].join("\n"),
    );
    const led1 = foldTranscriptIntoLedger(dir, p, "stage-x", false);
    expect(led1.totals.tokens.output).toBe(0);
    expect(led1.totals.tokens.input).toBe(0);

    // The real-usage tool_use line for x (the tokens the old guard lost).
    appendFileSync(
      p,
      [
        assistantLine({ uuid: "x-tool", timestamp: "t2", model: "opus", input: 17891, output: 404, cacheRead: 74692, msgId: "x" }),
        "",
      ].join("\n"),
    );
    const led2 = foldTranscriptIntoLedger(dir, p, "stage-x", true);
    expect(led2.totals.tokens.output).toBe(404);
    expect(led2.totals.tokens.input).toBe(17891);
    expect(led2.totals.tokens.cacheRead).toBe(74692);

    // And it equals a single whole-file flush fold in a fresh project.
    const dir2 = mkProject();
    const p2 = join(dir2, "session.jsonl");
    writeFileSync(
      p2,
      [
        assistantLine({ uuid: "x-think", timestamp: "t1", model: "opus", input: 0, output: 0, msgId: "x" }),
        assistantLine({ uuid: "x-tool", timestamp: "t2", model: "opus", input: 17891, output: 404, cacheRead: 74692, msgId: "x" }),
        "",
      ].join("\n"),
    );
    const whole = foldTranscriptIntoLedger(dir2, p2, "stage-x", true);
    expect(led2.totals.tokens).toEqual(whole.totals.tokens);
  });

  test("INCREMENTAL-EQUALS-WHOLEFILE: new-style file revealed in growing chunks (incl. mid-line boundary) == single flush fold", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    const groupLines = (id: string, inTok: number, outTok: number): string[] => [
      assistantLine({ uuid: `${id}-think`, timestamp: `${id}1`, model: "converse/us.anthropic.claude-opus-4-8", input: 0, output: 0, msgId: id }),
      assistantLine({ uuid: `${id}-text`, timestamp: `${id}2`, model: "converse/us.anthropic.claude-opus-4-8", input: 0, output: 0, msgId: id }),
      assistantLine({ uuid: `${id}-tool`, timestamp: `${id}3`, model: "converse/us.anthropic.claude-opus-4-8", input: inTok, output: outTok, cacheRead: inTok * 2, msgId: id }),
    ];
    const allLines = [
      ...groupLines("g1", 1000, 30),
      ...groupLines("g2", 2500, 70),
      ...groupLines("g3", 400, 12),
      ...groupLines("g4", 9999, 321),
    ];
    const full = allLines.join("\n") + "\n";
    const fullBytes = Buffer.from(full, "utf-8");

    const cuts = [37, 150, 320, 500, 900, fullBytes.length - 10, fullBytes.length];
    for (let ci = 0; ci < cuts.length; ci++) {
      const end = Math.min(cuts[ci], fullBytes.length);
      writeFileSync(p, fullBytes.subarray(0, end));
      const isLast = ci === cuts.length - 1;
      foldTranscriptIntoLedger(dir, p, "stage-x", isLast);
    }
    const incremental = loadLedger(dir);

    const dir2 = mkProject();
    const p2 = join(dir2, "session.jsonl");
    writeFileSync(p2, full);
    const whole = foldTranscriptIntoLedger(dir2, p2, "stage-x", true);

    expect(incremental.totals.tokens).toEqual(whole.totals.tokens);
    expect(incremental.totals.usd).toBeCloseTo(whole.totals.usd, 8);
    expect(whole.totals.tokens.input).toBe(1000 + 2500 + 400 + 9999);
    expect(whole.totals.tokens.output).toBe(30 + 70 + 12 + 321);
  });

  test("flush semantics: flush=false holds back the last group; a later close (or flush) counts it once", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    writeFileSync(
      p,
      [
        assistantLine({ uuid: "a1", timestamp: "t1", model: "opus", output: 10, msgId: "a" }),
        assistantLine({ uuid: "b1", timestamp: "t2", model: "opus", output: 20, msgId: "b" }),
        "",
      ].join("\n"),
    );
    const led1 = foldTranscriptIntoLedger(dir, p, null, false);
    // 'a' closed by 'b' starting => counted; 'b' held back.
    expect(led1.totals.tokens.output).toBe(10);
    // Fold #2 flush=false: no new bytes => 'b' still not closed, still held.
    const led2 = foldTranscriptIntoLedger(dir, p, null, false);
    expect(led2.totals.tokens.output).toBe(10);
    // Fold #3 flush=true: 'b' is now complete => counted exactly once.
    const led3 = foldTranscriptIntoLedger(dir, p, null, true);
    expect(led3.totals.tokens.output).toBe(30);
    // Re-flush is idempotent.
    const led4 = foldTranscriptIntoLedger(dir, p, null, true);
    expect(led4.totals.tokens.output).toBe(30);
  });

  test("byteOffset skip: re-folding a flushed file with no new bytes changes nothing; offset == file size", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    writeFileSync(
      p,
      [
        assistantLine({ uuid: "u1", timestamp: "t", model: "opus", output: 10, msgId: "m1" }),
        "",
      ].join("\n"),
    );
    const led1 = foldTranscriptIntoLedger(dir, p, null, true);
    expect(led1.totals.tokens.output).toBe(10);
    const size = statSync(p).size;
    expect(led1.cursors[p].byteOffset).toBe(size);
    const led2 = foldTranscriptIntoLedger(dir, p, null, true);
    expect(led2.totals.tokens.output).toBe(10);
    expect(led2.cursors[p].byteOffset).toBe(size);
  });

  test("syntactically partial trailing line is retained until the next fold", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    const complete = assistantLine({ uuid: "u1", timestamp: "t", model: "opus", output: 10, msgId: "m1" });
    const partial = assistantLine({
      uuid: "u2",
      timestamp: "t",
      model: "opus",
      output: 99,
      msgId: "m2",
    }).slice(0, -1);
    writeFileSync(p, `${complete}\n${partial}`); // missing final `}` and newline
    const led1 = foldTranscriptIntoLedger(dir, p, null, true);
    // The complete group before a malformed fragment is still held because the
    // fragment may be another split line for that same message.
    expect(led1.totals.tokens.output).toBe(0);
    const offsetAfter1 = led1.cursors[p].byteOffset;
    expect(offsetAfter1).toBe(0);
    appendFileSync(p, "}\n");
    const led2 = foldTranscriptIntoLedger(dir, p, null, true);
    expect(led2.totals.tokens.output).toBe(10 + 99);
  });

  test("partial EOF continuation with the same message id is counted once", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    const complete = assistantLine({
      uuid: "u1",
      timestamp: "t",
      model: "opus",
      output: 10,
      msgId: "shared-message",
    });
    const partial = assistantLine({
      uuid: "u2",
      timestamp: "t",
      model: "opus",
      output: 10,
      msgId: "shared-message",
    }).slice(0, -1);
    writeFileSync(p, `${complete}\n${partial}`);

    expect(foldTranscriptIntoLedger(dir, p, null, true).totals.tokens.output).toBe(0);
    appendFileSync(p, "}\n");
    expect(foldTranscriptIntoLedger(dir, p, null, true).totals.tokens.output).toBe(10);
  });

  test("flush parses a complete final JSON object without a trailing newline", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    writeFileSync(
      p,
      assistantLine({
        uuid: "eof",
        timestamp: "t",
        model: "opus",
        output: 99,
        msgId: "eof-message",
      }),
    );
    const led = foldTranscriptIntoLedger(dir, p, "stage-eof", "flush-all");
    expect(led.totals.tokens.output).toBe(99);
    expect(led.cursors[p].byteOffset).toBe(statSync(p).size);
  });

  test("held-back group retains the stage captured before a transition", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    writeFileSync(
      p,
      `${assistantLine({
        uuid: "a",
        timestamp: "t1",
        model: "opus",
        output: 10,
        msgId: "message-a",
      })}\n`,
    );
    foldTranscriptIntoLedger(dir, p, "stage-a", "holdback");
    appendFileSync(
      p,
      `${assistantLine({
        uuid: "b",
        timestamp: "t2",
        model: "opus",
        output: 20,
        msgId: "message-b",
      })}\n`,
    );
    const led = foldTranscriptIntoLedger(dir, p, "stage-b", "flush-all");
    const workflow = led.workflows["record:default/legacy"];
    expect(workflow.byStage["stage-a"].totals.tokens.output).toBe(10);
    expect(workflow.byStage["stage-b"].totals.tokens.output).toBe(20);
  });

  test("PreToolUse seal-main counts the completing call in its current stage", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    writeFileSync(
      p,
      assistantLine({
        uuid: "lifecycle",
        timestamp: "t",
        model: "opus",
        input: 100,
        msgId: "lifecycle-call",
      }),
    );
    const led = foldTranscriptIntoLedger(dir, p, "stage-a", "seal-main");
    expect(
      led.workflows["record:default/legacy"].byStage["stage-a"].totals.tokens
        .input,
    ).toBe(100);
  });

  test("multi-stage scoping still correct under incremental fold", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    writeFileSync(
      p,
      [
        assistantLine({ uuid: "a1", timestamp: "t", model: "converse/us.anthropic.claude-opus-4-8", input: 1_000_000, msgId: "ma" }),
        "",
      ].join("\n"),
    );
    foldTranscriptIntoLedger(dir, p, "stage-A", true);
    appendFileSync(
      p,
      [
        assistantLine({ uuid: "b1", timestamp: "t", model: "converse/au.anthropic.claude-sonnet-4-6", input: 1_000_000, msgId: "mb" }),
        "",
      ].join("\n"),
    );
    foldTranscriptIntoLedger(dir, p, "stage-B", true);
    const a = stageUsageAuditFields(dir, "stage-A");
    const b = stageUsageAuditFields(dir, "stage-B");
    expect(a["By Model"]).toBe("opus-4-8=5.00");
    expect(a["By Model"]).not.toContain("sonnet");
    expect(b["By Model"]).toBe("sonnet-4-6=3.00");
    expect(b["By Model"]).not.toContain("opus");
  });

  test("truncation/rotation (size < byteOffset) resets and re-reads the file", () => {
    const dir = mkProject();
    const p = join(dir, "session.jsonl");
    writeFileSync(
      p,
      [
        assistantLine({ uuid: "u1", timestamp: "t", model: "opus", output: 10, msgId: "m1" }),
        assistantLine({ uuid: "u2", timestamp: "t", model: "opus", output: 20, msgId: "m2" }),
        "",
      ].join("\n"),
    );
    const led1 = foldTranscriptIntoLedger(dir, p, null, true);
    expect(led1.totals.tokens.output).toBe(30);
    // Rotate: replace with a SHORTER file. size < prior byteOffset => reset.
    writeFileSync(
      p,
      [assistantLine({ uuid: "v1", timestamp: "t", model: "opus", output: 5, msgId: "n1" }), ""].join("\n"),
    );
    const led2 = foldTranscriptIntoLedger(dir, p, null, true);
    // The reset re-reads the (new) whole file and adds its 5 to the prior 30.
    expect(led2.totals.tokens.output).toBe(35);
    expect(led2.cursors[p].byteOffset).toBe(statSync(p).size);
  });

  test("offset-aware fold attributes sub-agent rows via sidecar each fold; per-file holdback", () => {
    const dir = mkProject();
    const main = join(dir, "session.jsonl");
    writeFileSync(
      main,
      [assistantLine({ uuid: "m1", timestamp: "t", model: "opus", output: 100, msgId: "mm" }), ""].join("\n"),
    );
    const subDir = join(dir, "session", "subagents");
    mkdirSync(subDir, { recursive: true });
    const subFile = join(subDir, "agent-abc.jsonl");
    writeFileSync(
      subFile,
      [assistantLine({ uuid: "s1", timestamp: "t", model: "haiku", output: 50, isSidechain: true, agentId: "abc", msgId: "ms" }), ""].join("\n"),
    );
    writeFileSync(
      join(subDir, "agent-abc.meta.json"),
      JSON.stringify({ agentType: "code-reviewer" }),
    );
    const led = foldTranscriptIntoLedger(dir, main, "stage-z", true);
    expect(led.totals.tokens.output).toBe(150);
    expect(led.byAgent["main"].tokens.output).toBe(100);
    expect(led.byAgent["code-reviewer"].tokens.output).toBe(50);
    // Cursors are keyed by FILE PATH (main + the sub-agent file), not "main"/"agent-abc".
    expect(led.cursors[main]).toBeDefined();
    expect(led.cursors[subFile]).toBeDefined();
    expect(led.cursors["main"]).toBeUndefined();
  });

  test("cross-session: a longer second session folds ADDITIVELY with NO skipped turns", () => {
    const dir = mkProject();
    const a = join(dir, "sessionA.jsonl");
    writeFileSync(
      a,
      [
        assistantLine({ uuid: "a1", timestamp: "t", model: "opus", output: 100, msgId: "a1" }),
        assistantLine({ uuid: "a2", timestamp: "t", model: "opus", output: 100, msgId: "a2" }),
        "",
      ].join("\n"),
    );
    const ledA = foldTranscriptIntoLedger(dir, a, null, true);
    expect(ledA.totals.tokens.output).toBe(200);
    const offsetA = ledA.cursors[a].byteOffset ?? -1;
    expect(offsetA).toBe(statSync(a).size);

    const b = join(dir, "sessionB.jsonl");
    const bLines: string[] = [];
    let expectedB = 0;
    for (let i = 0; i < 20; i++) {
      bLines.push(assistantLine({ uuid: `b${i}`, timestamp: "t", model: "opus", output: 7, msgId: `b${i}` }));
      expectedB += 7;
    }
    bLines.push("");
    writeFileSync(b, bLines.join("\n"));
    expect(statSync(b).size).toBeGreaterThan(offsetA);
    const ledB = foldTranscriptIntoLedger(dir, b, null, true);
    expect(ledB.totals.tokens.output).toBe(200 + expectedB);
    expect(ledB.cursors[b].byteOffset).toBe(statSync(b).size);
    expect(ledB.cursors[a].byteOffset).toBe(offsetA);
  });

  test("migration: an OLD-shape ledger is discarded; fold rebuilds == a single clean fold", () => {
    const dir = mkProject();
    mkdirSync(join(dir, "aidlc", ".aidlc-sessions"), { recursive: true });
    const transcript = join(dir, "session.jsonl");
    writeFileSync(
      transcript,
      [
        assistantLine({ uuid: "u1", timestamp: "t", model: "converse/us.anthropic.claude-opus-4-8", input: 500, output: 200, msgId: "m1" }),
        assistantLine({ uuid: "u2", timestamp: "t", model: "converse/us.anthropic.claude-opus-4-8", input: 300, output: 100, msgId: "m2" }),
        "",
      ].join("\n"),
    );
    // Write an OLD-shape ledger: inflated totals, an old lastUuid cursor with NO
    // byteOffset and NO schemaVersion.
    writeFileSync(
      ledgerPath(dir),
      JSON.stringify({
        cursors: { main: { lastUuid: "someOldUuid", lastTimestamp: "t" } },
        totals: { tokens: { input: 9_999_999, output: 8_888_888, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 }, usd: 124.0 },
        byStage: {},
        byModel: {},
        byAgent: {},
      }),
    );
    const loaded = loadLedger(dir);
    expect(loaded.totals.tokens.input).toBe(0);
    expect(loaded.totals.tokens.output).toBe(0);
    expect(loaded.schemaVersion).toBe(3);

    const led = foldTranscriptIntoLedger(dir, transcript, null, true);
    expect(led.totals.tokens.input).toBe(800); // 500 + 300
    expect(led.totals.tokens.output).toBe(300); // 200 + 100

    const dir2 = mkProject();
    const t2 = join(dir2, "session.jsonl");
    writeFileSync(t2, readFileSync(transcript));
    const clean = foldTranscriptIntoLedger(dir2, t2, null, true);
    expect(led.totals.tokens).toEqual(clean.totals.tokens);
  });

  test("migration: a v3 ledger with byteOffset cursors is PRESERVED (not reset)", () => {
    const dir = mkProject();
    mkdirSync(join(dir, "aidlc", ".aidlc-sessions"), { recursive: true });
    writeFileSync(
      ledgerPath(dir),
      JSON.stringify({
        schemaVersion: 3,
        cursors: { "/some/path.jsonl": { lastUuid: "u", lastTimestamp: "t", byteOffset: 42 } },
        totals: { tokens: { input: 111, output: 222, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 }, usd: 1.5 },
        byStage: {},
        byModel: {},
        byAgent: {},
        workflows: {},
      }),
    );
    const loaded = loadLedger(dir);
    expect(loaded.totals.tokens.input).toBe(111);
    expect(loaded.totals.tokens.output).toBe(222);
    expect(loaded.cursors["/some/path.jsonl"].byteOffset).toBe(42);
  });

  test("concurrent processes preserve every transcript fold", async () => {
    const dir = mkProject();
    const modulePath = join(
      import.meta.dir,
      "..",
      "..",
      "dist",
      "claude",
      ".claude",
      "tools",
      "aidlc-usage.ts",
    );
    const processes: ReturnType<typeof Bun.spawn>[] = [];
    for (let i = 0; i < 24; i++) {
      const transcript = join(dir, `session-${i}.jsonl`);
      writeFileSync(
        transcript,
        `${assistantLine({
          uuid: `u-${i}`,
          timestamp: "t",
          model: "opus",
          output: 1,
          msgId: `m-${i}`,
        })}\n`,
      );
      const script =
        `import { foldTranscriptIntoLedger } from ${JSON.stringify(modulePath)};` +
        `foldTranscriptIntoLedger(${JSON.stringify(dir)}, ${JSON.stringify(transcript)}, ` +
        `"stage-concurrent", "flush-all", { workflowKey: "intent:race" });`;
      processes.push(
        Bun.spawn([process.execPath, "-e", script], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
    }
    const exits = await Promise.all(processes.map((child) => child.exited));
    expect(exits.every((code) => code === 0)).toBe(true);
    const ledger = loadLedger(dir);
    expect(ledger.workflows["intent:race"].totals.tokens.output).toBe(24);
    expect(Object.keys(ledger.cursors)).toHaveLength(24);
  });
});
