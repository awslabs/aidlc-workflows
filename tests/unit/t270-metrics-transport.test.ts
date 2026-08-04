// covers: function:writeFileAtomic, function:appendAuditEntries, function:emitMetricForAuditEvent
//
// t270 - concurrency and metrics transport regressions from PR review:
//   - an atomic writer never reuses another writer's sibling temp path;
//   - endpoint, body, and secret custom-header values travel through stdin,
//     never worker argv or environment;
//   - batch audit appends pass every committed event through the same opt-in
//     metrics transport as a single append.
//
// Mechanism: deterministic local subprocess + loopback HTTP collector. The real
// detached Bun sender performs native fetch requests; no external service is
// involved.

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  appendAuditEntries,
} from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  writeFileAtomic,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  emitMetricForAuditEvent,
} from "../../dist/claude/.claude/tools/aidlc-metrics.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

interface MetricCapture {
  method: string;
  path: string;
  body: string;
  contentType: string | null;
  authorization: string | null;
  probe: string | null;
}

interface WorkerCapture {
  args: string[];
  envelope: {
    endpoint: string;
    body: string;
    headers: string[];
  };
  metricEnv: [string, string][];
}

const FAKE_COMPILED_WORKER = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const capture = {
  args: process.argv.slice(2),
  envelope: JSON.parse(readFileSync(0, "utf-8")),
  metricEnv: Object.entries(process.env).filter(([name]) => {
    const normalized = name.toUpperCase();
    return normalized === "AIDLC_METRICS_ENDPOINT" ||
      normalized === "AIDLC_METRICS_HEADERS";
  }),
};
writeFileSync(
  join(process.env.AIDLC_CAPTURE_DIR, process.pid + ".json"),
  JSON.stringify(capture),
  "utf-8",
);
`;

function installFakeCompiledWorker(): { executable: string; captures: string } {
  const root = freshRoot("aidlc-t270-worker-");
  const captures = join(root, "captures");
  mkdirSync(captures);
  const executable = join(root, "aidlc");
  writeFileSync(executable, FAKE_COMPILED_WORKER, "utf-8");
  chmodSync(executable, 0o755);
  return { executable, captures };
}

function startCollector(): {
  endpoint: string;
  captures: MetricCapture[];
  stop: () => void;
} {
  const captures: MetricCapture[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      captures.push({
        method: request.method,
        path: url.pathname,
        body: await request.text(),
        contentType: request.headers.get("content-type"),
        authorization: request.headers.get("authorization"),
        probe: request.headers.get("x-probe"),
      });
      return new Response("ok");
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}/ingest`,
    captures,
    stop: () => server.stop(true),
  };
}

async function waitForCaptures(
  captures: MetricCapture[],
  count: number,
): Promise<MetricCapture[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (captures.length >= count) return captures;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${count} metric request(s)`);
}

async function waitForWorkerCapture(dir: string): Promise<WorkerCapture> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const file = readdirSync(dir).find((name) => name.endsWith(".json"));
    if (file) {
      return JSON.parse(readFileSync(join(dir, file), "utf-8")) as WorkerCapture;
    }
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for metric worker capture");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("writeFileAtomic writer isolation", () => {
  test("leaves another writer's legacy sibling temp untouched", () => {
    const root = freshRoot("aidlc-t270-atomic-");
    const target = join(root, "state.json");
    const competingTemp = `${target}.tmp`;
    writeFileSync(competingTemp, "other writer\n", "utf-8");

    writeFileAtomic(target, "committed\n");

    expect(readFileSync(target, "utf-8")).toBe("committed\n");
    expect(readFileSync(competingTemp, "utf-8")).toBe("other writer\n");
    expect(readdirSync(root).sort()).toEqual([
      basename(target),
      basename(competingTemp),
    ].sort());
  });
});

describe("metrics Bun transport", () => {
  test("uses native fetch and keeps the request envelope out of argv/environment", async () => {
    const collector = startCollector();
    const project = freshRoot("aidlc-t270-project-");
    const secret = "argv-secret-7f4d2";
    const headers = [
      `Authorization: Bearer ${secret}`,
      'X-Probe: quote" slash\\ --next --output /tmp/exposed',
    ].join("\n");
    const priorEndpoint = process.env.AIDLC_METRICS_ENDPOINT;
    const priorHeaders = process.env.AIDLC_METRICS_HEADERS;

    try {
      process.env.AIDLC_METRICS_ENDPOINT = collector.endpoint;
      process.env.AIDLC_METRICS_HEADERS = headers;

      emitMetricForAuditEvent(
        "STAGE_STARTED",
        { Stage: "code-generation" },
        project,
      );
      const [capture] = await waitForCaptures(collector.captures, 1);
      const source = readFileSync(
        join(
          import.meta.dir,
          "..",
          "..",
          "dist",
          "claude",
          ".claude",
          "tools",
          "aidlc-metrics.ts",
        ),
        "utf-8",
      );

      expect(capture.method).toBe("POST");
      expect(capture.path).toBe("/ingest");
      expect(capture.contentType).toStartWith("text/plain");
      expect(capture.authorization).toBe(`Bearer ${secret}`);
      expect(capture.probe).toBe(
        'quote" slash\\ --next --output /tmp/exposed',
      );
      expect(capture.body).toStartWith("aidlc.stage_started:1|c|#");
      expect(source).not.toContain('spawn("curl"');
      expect(source).not.toContain('from "node:child_process"');
      expect(source).toContain(
        "[process.execPath, fileURLToPath(import.meta.url), METRIC_WORKER_ARG]",
      );
      expect(source).toContain("const executable = compiledExecutable()");
      expect(source).toContain("const child = Bun.spawn(metricWorkerCommand()");
      expect(source).toContain("child.stdin.write(JSON.stringify(envelope))");
      expect(source).toContain('normalized === "AIDLC_METRICS_HEADERS"');
      expect(source).toContain('normalized === "AIDLC_METRICS_ENDPOINT"');
    } finally {
      collector.stop();
      restoreEnv("AIDLC_METRICS_ENDPOINT", priorEndpoint);
      restoreEnv("AIDLC_METRICS_HEADERS", priorHeaders);
    }
  });

  test("keeps the actual worker argv and environment free of request data", async () => {
    const { executable, captures } = installFakeCompiledWorker();
    const project = freshRoot("aidlc-t270-worker-project-");
    const endpointSecret = "endpoint-secret-4d1b";
    const headerSecret = "header-secret-91ac";
    const envNames = [
      "AIDLC_COMPILED_EXECUTABLE",
      "AIDLC_METRICS_ENDPOINT",
      "AIDLC_METRICS_HEADERS",
      "Aidlc_Metrics_Endpoint",
      "aidlc_metrics_headers",
      "AIDLC_CAPTURE_DIR",
    ];
    const priorEnv = new Map(
      envNames.map((name) => [name, process.env[name]] as const),
    );

    try {
      process.env.AIDLC_COMPILED_EXECUTABLE = executable;
      process.env.AIDLC_METRICS_ENDPOINT =
        `https://metrics.invalid/${endpointSecret}`;
      process.env.AIDLC_METRICS_HEADERS =
        `Authorization: Bearer ${headerSecret}`;
      process.env.Aidlc_Metrics_Endpoint =
        `https://metrics.invalid/${endpointSecret}`;
      process.env.aidlc_metrics_headers =
        `Authorization: Bearer ${headerSecret}`;
      process.env.AIDLC_CAPTURE_DIR = captures;

      emitMetricForAuditEvent(
        "STAGE_STARTED",
        { Stage: "code-generation" },
        project,
      );
      const capture = await waitForWorkerCapture(captures);
      const argv = JSON.stringify(capture.args);

      expect(capture.args).toEqual(["--internal-metrics-send"]);
      expect(argv).not.toContain(endpointSecret);
      expect(argv).not.toContain(headerSecret);
      expect(capture.metricEnv).toEqual([]);
      expect(capture.envelope.endpoint).toContain(endpointSecret);
      expect(capture.envelope.headers).toContain(
        `Authorization: Bearer ${headerSecret}`,
      );
      expect(capture.envelope.body).toStartWith(
        "aidlc.stage_started:1|c|#",
      );
    } finally {
      for (const name of [...envNames].reverse()) {
        restoreEnv(name, priorEnv.get(name));
      }
    }
  });

  test("appendAuditEntries emits one metric transport per batch event", async () => {
    const collector = startCollector();
    const project = freshRoot("aidlc-t270-batch-");
    const priorEndpoint = process.env.AIDLC_METRICS_ENDPOINT;
    const priorHeaders = process.env.AIDLC_METRICS_HEADERS;

    try {
      process.env.AIDLC_METRICS_ENDPOINT = collector.endpoint;
      delete process.env.AIDLC_METRICS_HEADERS;

      const result = appendAuditEntries(
        [
          {
            eventType: "STAGE_STARTED",
            fields: { Stage: "code-generation" },
          },
          {
            eventType: "STAGE_COMPLETED",
            fields: { Stage: "code-generation" },
          },
        ],
        project,
      );
      const captured = await waitForCaptures(collector.captures, 2);
      const bodies = captured.map((capture) => capture.body);

      expect(result.events).toEqual(["STAGE_STARTED", "STAGE_COMPLETED"]);
      expect(
        bodies.some((body) => body.startsWith("aidlc.stage_started:1|c|#")),
      ).toBe(true);
      expect(
        bodies.some((body) => body.startsWith("aidlc.stage_completed:1|c|#")),
      ).toBe(true);
    } finally {
      collector.stop();
      restoreEnv("AIDLC_METRICS_ENDPOINT", priorEndpoint);
      restoreEnv("AIDLC_METRICS_HEADERS", priorHeaders);
    }
  });
});
