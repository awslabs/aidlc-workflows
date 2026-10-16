import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkPrompt, judgeMethodResponse } from "./crisp-mlq-benchmark.ts";
import { crispMlqReference } from "../tools/aws-mlops-crisp-mlq.ts";

// Explicit opt-in: two bounded CLI calls using the person's existing provider.
// This check edits no auth, trust, provider settings or installed project.
// The CLIs may maintain their own normal logs/caches.
const live = process.env.AIDLC_MLOPS_LIVE === "1";
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = resolve(process.env.AIDLC_MLOPS_REPORT_DIR ??
  join(pluginRoot, "../../tests/logs/aws-mlops-methodology"));
const reference = readFileSync(join(pluginRoot, crispMlqReference.knowledge_file), "utf-8");
const prompt = benchmarkPrompt(reference);
const timeoutMs = Number(process.env.AIDLC_MLOPS_LIVE_TIMEOUT_MS ?? 180_000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
  throw new Error("AIDLC_MLOPS_LIVE_TIMEOUT_MS must be between 1 and 600000.");
}

// A CLI may return valid JSON wrapped in a markdown code fence even when asked
// for raw JSON. Strip a single leading/trailing fence before parsing; the
// fenced content is unchanged, so this adds robustness without masking a real
// malformed response.
function parseJsonMaybeFenced(text: string): unknown {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return JSON.parse(fence ? fence[1] : trimmed);
}

for (const harness of ["claude", "codex"] as const) {
  test.skipIf(!live)(`${harness}: supplied method guides six controlled cases`, async () => {
    const bin = process.env[harness === "claude" ? "AIDLC_MLOPS_CLAUDE_BIN" : "AIDLC_CODEX_BIN"] ?? harness;
    expect(Bun.which(bin), `${bin} must be installed for the selected live check`).not.toBeNull();
    const scratch = mkdtempSync(join(tmpdir(), `aidlc-method-${harness}-`));
    mkdirSync(reportDir, { recursive: true });
    const model = process.env[harness === "claude" ? "AIDLC_MLOPS_CLAUDE_MODEL" : "AIDLC_MLOPS_CODEX_MODEL"];
    const outputPath = join(scratch, "response.json");
    const args = harness === "claude"
      ? ["-p", "--output-format", "json", "--no-session-persistence", "--tools", "", "--max-budget-usd", "2", ...(model ? ["--model", model] : [])]
      : ["exec", "--ephemeral", "--skip-git-repo-check", "--output-last-message", outputPath, ...(model ? ["--model", model] : []), "-"];
    const proc = Bun.spawn([bin, ...args], {
      cwd: scratch, stdin: new TextEncoder().encode(prompt),
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      let value: unknown = null;
      let modelIds: string[] = [];
      let parseError: string | null = null;
      try {
        if (harness === "claude") {
          const envelope = JSON.parse(stdout) as { result?: string; modelUsage?: Record<string, unknown> };
          modelIds = Object.keys(envelope.modelUsage ?? {});
          value = parseJsonMaybeFenced(envelope.result ?? "");
        } else {
          const headerModel = /^model:\s*(.+)$/m.exec(`${stderr}\n${stdout}`)?.[1];
          modelIds = headerModel ? [headerModel] : [];
          value = parseJsonMaybeFenced(readFileSync(outputPath, "utf-8"));
        }
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
      const findings = exit === 0 && parseError === null
        ? judgeMethodResponse(value)
        : [`CLI exit ${exit}; response parse error: ${parseError ?? "none"}.`];
      if (exit === 0 && modelIds.length === 0) findings.push("The CLI did not report its model identity.");
      writeFileSync(join(reportDir, `${harness}.json`), JSON.stringify({
        harness, requested_model: model ?? "configured-default", reported_models: modelIds,
        model_identity_source: harness === "claude" ? "CLI modelUsage" : "CLI execution header",
        reference_revision: crispMlqReference.revision,
        reference_sha256: createHash("sha256").update(reference).digest("hex"),
        prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
        timestamp: new Date().toISOString(), exit, findings, response: value,
        scope: "controlled responses with supplied reference; not live workflow delivery or AWS verification",
        semantic_review: "required in addition to deterministic action/coverage checks",
      }, null, 2));
      // Raw transcripts stay in ignored local evidence for diagnosis, not source.
      writeFileSync(join(reportDir, `${harness}.stdout.log`), stdout);
      writeFileSync(join(reportDir, `${harness}.stderr.log`), stderr);
      expect(findings, `See ${join(reportDir, `${harness}.json`)}`).toEqual([]);
    } finally {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, timeoutMs + 10_000);
}
