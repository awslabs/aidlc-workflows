#!/usr/bin/env bun
// Run a PowerShell command on the MR10 Windows test instance through SSM.

import { spawnSync } from "node:child_process";
import {
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../test-budget.ts";

interface Cli {
  instanceId?: string;
  stackName?: string;
  region: string;
  timeoutSeconds: number;
  pollSeconds: number;
  command: string[];
}

export function runAws(args: string[], input?: string, deadlineMs?: number): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("aws", args, {
    input,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { deadlineMs, phase: "Windows SSM API" }),
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  bun tests/harness/windows/ssm-run.ts --stack-name NAME [--region REGION] -- powershell ...",
      "  bun tests/harness/windows/ssm-run.ts --instance-id i-... [--region REGION] -- powershell ...",
      "",
      "Defaults:",
      "  --region: AWS_REGION / AWS_DEFAULT_REGION / us-east-1",
      "  --instance-id: AIDLC_WINDOWS_INSTANCE_ID",
      "  --stack-name: AIDLC_WINDOWS_STACK_NAME",
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
    timeoutSeconds: LIVE_LONG_OPERATION_TIMEOUT_MS / 1000,
    pollSeconds: 5,
    command: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.command = argv.slice(i + 1);
      break;
    }
    if (a === "--instance-id") out.instanceId = argv[++i];
    else if (a === "--stack-name") out.stackName = argv[++i];
    else if (a === "--region") out.region = argv[++i] ?? out.region;
    else if (a === "--timeout-seconds") out.timeoutSeconds = Number(argv[++i] ?? out.timeoutSeconds);
    else if (a === "--poll-seconds") out.pollSeconds = Number(argv[++i] ?? out.pollSeconds);
    else usage();
  }
  if (out.command.length === 0) usage();
  return out;
}

export function instanceIdForStack(stackName: string, region: string): string {
  const r = runAws([
    "cloudformation",
    "describe-stack-resources",
    "--region",
    region,
    "--stack-name",
    stackName,
    "--logical-resource-id",
    "WindowsTestInstance",
    "--query",
    "StackResources[0].PhysicalResourceId",
    "--output",
    "text",
  ]);
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || `could not resolve instance for stack ${stackName}`);
  }
  const id = r.stdout.trim();
  if (!/^i-[A-Za-z0-9]+$/.test(id)) throw new Error(`unexpected instance id from stack ${stackName}: ${id}`);
  return id;
}

export function resolveInstanceId(cli: Pick<Cli, "instanceId" | "stackName" | "region">): string {
  if (cli.instanceId) return cli.instanceId;
  if (cli.stackName) return instanceIdForStack(cli.stackName, cli.region);
  throw new Error("provide --instance-id, --stack-name, AIDLC_WINDOWS_INSTANCE_ID, or AIDLC_WINDOWS_STACK_NAME");
}

export function sendPowerShell(
  instanceId: string,
  region: string,
  command: string,
  timeoutSeconds: number,
): string {
  const parameters = JSON.stringify({
    commands: [command],
    executionTimeout: [String(timeoutSeconds)],
  });
  const r = runAws([
    "ssm",
    "send-command",
    "--region",
    region,
    "--instance-ids",
    instanceId,
    "--document-name",
    "AWS-RunPowerShellScript",
    "--parameters",
    parameters,
    "--timeout-seconds",
    String(timeoutSeconds),
    "--query",
    "Command.CommandId",
    "--output",
    "text",
  ]);
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || "ssm send-command failed");
  return r.stdout.trim();
}

export function getInvocation(instanceId: string, region: string, commandId: string, deadlineMs?: number): {
  status: string;
  stdout: string;
  stderr: string;
  responseCode: number;
} {
  const r = runAws([
    "ssm",
    "get-command-invocation",
    "--region",
    region,
    "--instance-id",
    instanceId,
    "--command-id",
    commandId,
    "--query",
    "{status:Status,stdout:StandardOutputContent,stderr:StandardErrorContent,responseCode:ResponseCode}",
    "--output",
    "json",
  ], undefined, deadlineMs);
  if (r.status !== 0) {
    return { status: "Pending", stdout: "", stderr: r.stderr || r.stdout, responseCode: -1 };
  }
  return JSON.parse(r.stdout) as {
    status: string;
    stdout: string;
    stderr: string;
    responseCode: number;
  };
}

export async function waitForInvocation(
  instanceId: string,
  region: string,
  commandId: string,
  pollSeconds: number,
  timeoutMs = NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
): Promise<ReturnType<typeof getInvocation>> {
  const deadline = Date.now() + remainingOperationTimeoutMs(timeoutMs, { phase: "SSM invocation observation" })!;
  for (;;) {
    if (Date.now() >= deadline) throw new Error("SSM invocation observation deadline expired; remote exit remains unconfirmed");
    const inv = getInvocation(instanceId, region, commandId, deadline);
    if (Date.now() >= deadline) throw new Error("SSM invocation observation deadline expired; remote exit remains unconfirmed");
    if (["Success", "Failed", "Cancelled", "TimedOut", "Cancelling"].includes(inv.status)) {
      return inv;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(pollSeconds * 1000, deadline - Date.now()))));
  }
}

if (import.meta.main) {
  try {
    const cli = parse(process.argv.slice(2));
    const instanceId = resolveInstanceId(cli);
    // SSM's AWS-RunPowerShellScript wraps the command in an outer PowerShell
    // session. A nested invocation (`powershell -File run-all.ps1`, `& script`)
    // sets $LASTEXITCODE in that outer session but the session itself still
    // exits 0, so a failed test run would report rc 0 (verified on the box).
    // Propagate explicitly; commands that already exit never reach the suffix.
    const command = `${cli.command.join(" ")}; exit $LASTEXITCODE`;
    process.stdout.write(`SSM target: ${instanceId} (${cli.region})\n`);
    const commandId = sendPowerShell(instanceId, cli.region, command, cli.timeoutSeconds);
    process.stdout.write(`SSM command: ${commandId}\n`);
    const inv = await waitForInvocation(instanceId, cli.region, commandId, cli.pollSeconds, 2 * cli.timeoutSeconds * 1000 + NATIVE_STARTUP_TIMEOUT_MS);
    if (inv.stdout) process.stdout.write(inv.stdout);
    if (inv.stderr) process.stderr.write(inv.stderr);
    // Mirror the remote exit code: Success carries it directly; Failed carries
    // it in responseCode too (e.g. a red test run), so prefer the real code
    // over a flattened 1 whenever SSM reports one.
    process.exit(inv.responseCode >= 0 ? inv.responseCode : 1);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
