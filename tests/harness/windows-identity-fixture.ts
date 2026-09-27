// Test-only wire replies for the native process-detail bridge. Preserve invalid
// and extra rows so negative controls still exercise the production decoder.
import type { BoundedCommandResult, WindowsProcessIdentity } from "./tui-drive.ts";

export function withNativeGeneration(row: WindowsProcessIdentity): WindowsProcessIdentity {
  const milliseconds = Date.parse(row.creationDate);
  return { ...row, nativeIdentity: row.nativeIdentity ?? (Number.isFinite(milliseconds)
    ? `win32:${row.pid}:${(BigInt(milliseconds) + 11_644_473_600_000n) * 10_000n}` : "invalid") };
}

export function nativeSnapshotReply(pids: number[], rows: unknown): BoundedCommandResult {
  const value = Array.isArray(rows) ? [
    ...rows.map(row => ({ pid: row?.pid, identity: row && typeof row === "object" ? withNativeGeneration(row) : row })),
    ...pids.filter(pid => !rows.some(row => row?.pid === pid)).map(pid => ({ pid, identity: null })),
  ] : rows;
  return { status: 0, stdout: Buffer.from(JSON.stringify(value)).toString("base64"), stderr: "", timedOut: false };
}
