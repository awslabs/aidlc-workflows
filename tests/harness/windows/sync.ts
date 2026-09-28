#!/usr/bin/env bun
// Sync the current git tree to the MR10 Windows test host through SSM.

import { spawnSync } from "node:child_process";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../test-budget.ts";
import { gzipSync } from "node:zlib";
import { resolveInstanceId, sendPowerShell, waitForInvocation } from "./ssm-run.ts";

interface Cli {
  instanceId?: string;
  stackName?: string;
  region: string;
  ref: string;
  dest: string;
}

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  bun tests/harness/windows/sync.ts [--stack-name NAME | --instance-id i-...] [--region REGION] [--dest C:\\aidlc] [REF]",
      "",
      "REF defaults to HEAD. Instance and stack may also come from AIDLC_WINDOWS_INSTANCE_ID",
      "or AIDLC_WINDOWS_STACK_NAME. Run from the repo root.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function parse(argv: string[]): Cli {
  const out: Cli = {
    instanceId: process.env.AIDLC_WINDOWS_INSTANCE_ID,
    stackName: process.env.AIDLC_WINDOWS_STACK_NAME,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
    ref: "HEAD",
    dest: "C:\\aidlc",
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--instance-id") out.instanceId = argv[++i];
    else if (a === "--stack-name") out.stackName = argv[++i];
    else if (a === "--region") out.region = argv[++i] ?? out.region;
    else if (a === "--dest") out.dest = argv[++i] ?? out.dest;
    else if (a === "-h" || a === "--help") usage();
    else positional.push(a);
  }
  if (positional[0]) out.ref = positional[0];
  if (positional[1]) out.dest = positional[1];
  return out;
}

function gitArchive(ref: string): Buffer {
  const r = spawnSync("git", ["archive", "--format=tar", ref], {
    encoding: "buffer",
    maxBuffer: 200 * 1024 * 1024,
    timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS, { phase: "Windows sync archive" }),
  });
  if (r.status !== 0) {
    throw new Error((r.stderr as Buffer).toString("utf8") || `git archive ${ref} failed`);
  }
  return r.stdout as Buffer;
}

function psSingle(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function runPs(instanceId: string, region: string, command: string, timeoutSeconds = NATIVE_FIXTURE_SETUP_TIMEOUT_MS / 1000): Promise<void> {
  const commandId = sendPowerShell(instanceId, region, command, timeoutSeconds);
  const inv = await waitForInvocation(instanceId, region, commandId, 3, 2 * timeoutSeconds * 1000);
  if (inv.stdout) process.stdout.write(inv.stdout);
  if (inv.stderr) process.stderr.write(inv.stderr);
  if (inv.status !== "Success" || inv.responseCode !== 0) {
    throw new Error(`SSM command ${commandId} failed (${inv.status}, rc ${inv.responseCode})`);
  }
}

function chunks(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

if (import.meta.main) {
  try {
    const cli = parse(process.argv.slice(2));
    const instanceId = resolveInstanceId(cli);
    process.stdout.write(`=== git archive ${cli.ref} -> gzip -> base64 ===\n`);
    const gz = gzipSync(gitArchive(cli.ref));
    const b64 = gz.toString("base64");
    const parts = chunks(b64, 12000);
    process.stdout.write(`archive size: ${Math.ceil(gz.length / 1024)} KiB\n`);
    process.stdout.write(`chunks: ${parts.length}\n`);

    const dest = psSingle(cli.dest);
    await runPs(
      instanceId,
      cli.region,
      [
        `$dest = ${dest}`,
        "New-Item -ItemType Directory -Force -Path $dest | Out-Null",
        "Get-ChildItem -Path $dest -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'node_modules' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue",
        "Set-Content -Path (Join-Path $dest 'tree.b64') -Value '' -NoNewline",
        "Write-Output 'prepared (wiped prior tree, preserved node_modules)'",
      ].join("; "),
    );

    for (let i = 0; i < parts.length; i++) {
      await runPs(
        instanceId,
        cli.region,
        `$dest = ${dest}; Add-Content -Path (Join-Path $dest 'tree.b64') -Value ${psSingle(parts[i])} -NoNewline; Write-Output 'chunk ${i + 1}/${parts.length}'`,
        NATIVE_FIXTURE_SETUP_TIMEOUT_MS / 1000,
      );
    }

    await runPs(
      instanceId,
      cli.region,
      [
        `$dest = ${dest}`,
        "Set-Location $dest",
        "$bytes = [Convert]::FromBase64String((Get-Content (Join-Path $dest 'tree.b64') -Raw))",
        "[IO.File]::WriteAllBytes((Join-Path $dest 'tree.tar.gz'), $bytes)",
        "tar -xzf (Join-Path $dest 'tree.tar.gz') -C $dest",
        "Remove-Item (Join-Path $dest 'tree.b64'),(Join-Path $dest 'tree.tar.gz')",
        "if (Test-Path (Join-Path $dest 'package.json')) { Write-Output 'EXTRACT-OK: package.json present' } else { throw 'extract failed: no package.json' }",
      ].join("; "),
    );

    process.stdout.write(`=== sync complete -> ${cli.dest} ===\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
