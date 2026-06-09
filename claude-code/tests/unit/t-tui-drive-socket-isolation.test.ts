// covers: function:tui-drive:tmux-socket-isolation
//
// t-tui-drive-socket-isolation.test.ts — a deterministic, token-free guard that
// the tmux backend runs on a PRIVATE tmux server socket (`tmux -L <socket>`),
// never the default server the developer's interactive shell is attached to.
//
// WHY THIS GUARD EXISTS (a real incident): tui-drive.ts originally called
// `spawnSync("tmux", args)` with no `-L`, so every harness new-session /
// kill-session landed on the DEFAULT tmux server — the same one a developer's
// live session is attached to. Server-level resource pressure from the live tui
// tier (or a kill targeting a stale name) could then take down the session the
// developer was working in (observed: crashes that needed a restart). The fix
// routes every tmux call through a private `-L aidlc-tui` socket. This test pins
// that: a regression that drops the `-L` flag re-exposes the developer's session,
// so it must fail loudly and deterministically — no claude, no tmux, no tokens.
//
// It is a SOURCE-LEVEL assertion (reads the driver's tmux() helper text), which
// is OS-invariant and runs in the deterministic unit tier. A behavioural check
// would need a live tmux server; the contract we protect — "the harness never
// touches the default server" — is fully expressed by the presence of `-L
// <socket>` ahead of the tmux args at the single chokepoint.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIVER_SRC = readFileSync(
  join(import.meta.dir, "..", "harness", "tui-drive.ts"),
  "utf8",
);

describe("tui-drive tmux backend runs on a private socket (developer-session safety)", () => {
  test("a private TMUX_SOCKET is defined with a non-empty default", () => {
    // The socket name must default to a concrete private label, overridable via
    // AIDLC_TUI_TMUX_SOCKET, so the harness never shares the default server.
    expect(DRIVER_SRC).toMatch(
      /const\s+TMUX_SOCKET\s*=\s*process\.env\.AIDLC_TUI_TMUX_SOCKET\s*\|\|\s*"[^"]+"/,
    );
  });

  test("the single tmux() chokepoint passes -L <socket> ahead of the args", () => {
    // Every backend op (start/send/capture/kill) funnels through tmux(); the -L
    // flag MUST be injected here and MUST precede the tmux subcommand, or the call
    // hits the default server. Pin the exact shape.
    expect(DRIVER_SRC).toMatch(
      /spawnSync\(\s*"tmux"\s*,\s*\[\s*"-L"\s*,\s*TMUX_SOCKET\s*,\s*\.\.\.args\s*\]/,
    );
  });

  test("no tmux server op bypasses the helper onto the default server", () => {
    // A bare `spawnSync("tmux", [..., "new-session"|"kill-session", ...])` outside
    // the helper would land on the default server. The only permitted direct
    // spawnSync("tmux", ...) calls are version probes (`tmux -V`) in skipReason
    // gates, which touch no server. Assert no direct spawnSync invokes a
    // server-touching subcommand.
    const directTmuxSpawns = [
      ...DRIVER_SRC.matchAll(/spawnSync\(\s*"tmux"\s*,\s*\[([^\]]*)\]/g),
    ];
    for (const m of directTmuxSpawns) {
      const argsText = m[1];
      // The helper itself matches here (it contains "-L", TMUX_SOCKET, ...args) —
      // that is the SAFE one. Any OTHER direct spawn must be a `-V` version probe.
      const isHelper = /"-L"\s*,\s*TMUX_SOCKET/.test(argsText);
      const isVersionProbe = /"-V"/.test(argsText);
      expect(isHelper || isVersionProbe).toBe(true);
    }
  });
});
