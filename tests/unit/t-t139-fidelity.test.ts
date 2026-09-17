import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  comparableTerminal,
  guardBypassCommands,
  hasAdvancedMilestone,
  nativeToolCalls,
} from "../harness/t139-fidelity.ts";

const FLAG = "AIDLC_DISABLE_ENSEMBLE_EVIDENCE";
const command = (text: string) => [{ name: "Bash", input: { command: text } }];

describe("t139 native shell fidelity", () => {
  test("rejects the observed opt-outs and option-bearing env assignments", () => {
    const enabled = [
      `${FLAG}=1 bun .claude/tools/aidlc.ts engine orchestrate report --result revised 2>&1`,
      `env ${FLAG}="1" bun .claude/tools/aidlc.ts engine orchestrate report --result approved`,
      `env -u AIDLC_SKIP_REVISION_BACKSTOP ${FLAG}=1 bun .claude/tools/aidlc.ts engine orchestrate report`,
      `/usr/bin/env --unset=AIDLC_SKIP_REVISION_BACKSTOP '${FLAG}=1' bun run.ts`,
      `env -uAIDLC_SKIP_REVISION_BACKSTOP -- ${FLAG}='1' bun run.ts`,
      "export AIDLC_SKIP_REVISION_BACKSTOP=1; bun run.ts",
      "echo ready\nAIDLC_SKIP_ARTIFACT_GUARD='1' bun run.ts",
      `2>/dev/null ${FLAG}=1 bun run.ts`,
      `env -S '${FLAG}=1 bun run.ts'`,
      `bash -lc '${FLAG}=1 bun run.ts'`,
      `echo "$(${FLAG}=1 bun run.ts)"`,
    ];
    for (const text of enabled) expect(guardBypassCommands(command(text))).toEqual([text]);
  });

  test("preserves the exact backstop unset launcher and recognizes unset values as names", () => {
    const safe = [
      "env -u AIDLC_SKIP_REVISION_BACKSTOP claude --setting-sources project --dangerously-skip-permissions",
      `env --unset ${FLAG} bun run.ts`,
      `${FLAG}=1 env -u ${FLAG} bun run.ts`,
      `${FLAG}=1 env -i bun run.ts`,
      `${FLAG}=0 bun run.ts`,
      `env -C '${FLAG}=1' bun run.ts`,
    ];
    for (const text of safe) expect(guardBypassCommands(command(text))).toEqual([]);
  });

  test("quoted multiline words, comments and heredoc bodies are data", () => {
    const safe = [
      `cat <<'EOF'\n${FLAG}=1\nEOF`,
      `cat <<"EOF"\n${FLAG}=1\nEOF\n`,
      `cat <<\\EOF\n${FLAG}=1\nEOF\n`,
      `cat <<- 'EOF'\n\t${FLAG}=1\n\tEOF\n`,
      `cat <<EOF\n${FLAG}=1\nEOF\n`,
      `cat <<'FIRST' <<'SECOND'\n${FLAG}=1\nFIRST\n${FLAG}=1\nSECOND\n`,
      `cat <<'EOF'; echo '${FLAG}=1'\n${FLAG}=1\nEOF\n`,
      `printf '%s\\n' 'documentation;\n${FLAG}=1\nmore documentation'`,
      `echo "documentation\n${FLAG}=1"`,
      `grep -n "${FLAG}=1" stage-protocol-ensemble.md`,
      `# ${FLAG}=1\nprintf safe`,
      `cat <<'EOF'\n$(${FLAG}=1 bun run.ts)\nEOF\n`,
    ];
    for (const text of safe) expect(guardBypassCommands(command(text))).toEqual([]);
  });

  test("real commands after a heredoc and expansions in unquoted heredocs still count", () => {
    const enabled = [
      `cat <<'EOF'\n${FLAG}=1\nEOF\n${FLAG}=1 bun run.ts`,
      `cat <<EOF\n$(${FLAG}=1 bun run.ts)\nEOF\n`,
    ];
    for (const text of enabled) expect(guardBypassCommands(command(text))).toEqual([text]);
  });

  test("only assistant tool requests count, not documentation or tool results", () => {
    const rows = [
      { type: "assistant", message: { content: [{ type: "text", text: `${FLAG}=1` }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: `${FLAG}=1` }] } },
      { type: "assistant", message: { content: [
        { type: "tool_use", name: "Read", input: { file_path: "stage-protocol-ensemble.md" } },
        { type: "tool_use", name: "Bash", input: { command: `grep -n "${FLAG}=1" stage-protocol-ensemble.md` } },
        { type: "tool_use", name: "Bash", input: { command: "env -u AIDLC_SKIP_REVISION_BACKSTOP claude --setting-sources project --dangerously-skip-permissions" } },
      ] } },
    ];
    const calls = nativeToolCalls(rows.map((row) => JSON.stringify(row)).join("\n"));
    expect(calls).toHaveLength(3);
    expect(guardBypassCommands(calls)).toEqual([]);
  });

  test("env options compose with shell utilities and nested env unsets", () => {
    const enabled = [
      `env -u AIDLC_SKIP_REVISION_BACKSTOP bash -c '${FLAG}=1 bun run.ts'`,
      `/usr/bin/env --unset=AIDLC_SKIP_REVISION_BACKSTOP sh -lc '${FLAG}=1 bun run.ts'`,
      `env -u AIDLC_SKIP_REVISION_BACKSTOP env -u OTHER bash -c '${FLAG}=1 bun run.ts'`,
    ];
    for (const text of enabled) expect(guardBypassCommands(command(text))).toEqual([text]);
    const safe = [
      `env -u AIDLC_SKIP_REVISION_BACKSTOP bash -c 'printf "%s\\n" "${FLAG}=1"'`,
      `env ${FLAG}=1 env -u ${FLAG} bash -c 'printf safe'`,
      `env -u AIDLC_SKIP_REVISION_BACKSTOP bash -c 'cat <<"EOF"\n${FLAG}=1\nEOF'`,
    ];
    for (const text of safe) expect(guardBypassCommands(command(text))).toEqual([]);
  });

  test("backticks execute outside single quotes but escaped and quoted backticks remain data", () => {
    const enabled = [
      `echo "\`${FLAG}=1 bun run.ts\`"`,
      `echo \`${FLAG}=1 bun run.ts\``,
      `cat <<EOF\n\`${FLAG}=1 bun run.ts\`\nEOF\n`,
    ];
    for (const text of enabled) expect(guardBypassCommands(command(text))).toEqual([text]);
    const safe = [
      `echo '\`${FLAG}=1 bun run.ts\`'`,
      `echo "\\\`${FLAG}=1 bun run.ts\\\`"`,
      `echo \\\`${FLAG}=1 bun run.ts\\\``,
      `cat <<'EOF'\n\`${FLAG}=1 bun run.ts\`\nEOF\n`,
    ];
    for (const text of safe) expect(guardBypassCommands(command(text))).toEqual([]);
  });

  test("substitution boundaries ignore quoted heredoc parentheses without hiding subsequent execution", () => {
    const safe = [
      `echo "$(cat <<'EOF'\n)\nEOF\n)"`,
      `echo "$(cat <<'ONE' <<'TWO'\n)\nONE\n(\nTWO\n)"`,
      `echo "$(cat <<-'EOF'\n\t) $(${FLAG}=1 bun run.ts)\n\tEOF\n)"`,
      `echo "$(printf '%s' "$(cat <<'EOF'\n)\nEOF\n)")"`,
    ];
    for (const text of safe) expect(guardBypassCommands(command(text))).toEqual([]);
    const enabled = `echo "$(cat <<'EOF'\n)\nEOF\n${FLAG}=1 bun run.ts\n)"`;
    expect(guardBypassCommands(command(enabled))).toEqual([enabled]);
  });
});

const completed = ["workspace-scaffold", "workspace-detection", "state-init", "reverse-engineering", "requirements-analysis"];
const intermediate = { completedCounter: 5, completedSlugs: completed, currentStage: "requirements-analysis", phase: "INCEPTION" };
const advanced = { ...intermediate, currentStage: "code-generation", phase: "CONSTRUCTION" };

describe("t139 comparable completion milestone", () => {
  test("does not sample approval's intermediate Completed write", async () => {
    let now = 0;
    let reads = 0;
    const sampled = await comparableTerminal(() => {
      reads++;
      return now < 25 ? intermediate : advanced;
    }, 1_000, { now: () => now, pause: async (ms) => { now += ms; } });
    expect(sampled).toEqual(advanced);
    expect(reads).toBe(2);
    expect(now).toBe(25);
    expect(hasAdvancedMilestone({ ...advanced, completedCounter: 4 })).toBe(false);
  });

  test("returns an already advanced state without waiting or normalizing its phase", async () => {
    const wrongPhase = { ...advanced, phase: "INCEPTION" };
    const sampled = await comparableTerminal(() => wrongPhase, 100, {
      now: () => 0,
      pause: async () => { throw new Error("unexpected wait"); },
    });
    expect(sampled).toBe(wrongPhase);
    expect(sampled.phase).toBe("INCEPTION"); // The unchanged live phase assertion must reject this.
  });

  test.each([75, 10_000])("wait is bounded by the original deadline and a five-second observation cap (%i)", async (deadline) => {
    let now = 0;
    await expect(comparableTerminal(() => intermediate, deadline, {
      now: () => now,
      pause: async (ms) => { now += ms; },
    })).rejects.toThrow("existing deadline");
    expect(now).toBe(Math.min(deadline, 5_000));
    expect(intermediate.phase).toBe("INCEPTION");
  });
});

// Optional, read-only replay data. This changes neither runner defaults nor
// the live test's profile: every listed native transcript is classified as-is.
const replayManifest = process.env.AIDLC_T139_REPLAY_MANIFEST;
if (replayManifest) {
  const cases = JSON.parse(readFileSync(replayManifest, "utf8")) as Array<{
    label: string;
    files: string[];
    bashCalls: number;
    optOuts: string[];
  }>;
  for (const replay of cases) {
    test(`saved native replay: ${replay.label}`, () => {
      expect(replay.files.length).toBeGreaterThan(0);
      const calls = replay.files.flatMap((path) => nativeToolCalls(readFileSync(path, "utf8")));
      expect(calls.filter((call) => call.name === "Bash")).toHaveLength(replay.bashCalls);
      expect(guardBypassCommands(calls)).toEqual(replay.optOuts);
      console.log(`native replay ${replay.label}: ${replay.bashCalls} Bash calls; ${replay.optOuts.length} opt-outs`);
    });
  }
}
