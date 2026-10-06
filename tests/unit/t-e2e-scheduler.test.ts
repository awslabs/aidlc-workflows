import { describe, expect, test } from "bun:test";
import {
  type E2eLimits,
  type E2eQueueEvent,
  type E2eResource,
  type E2eTask,
  runE2eQueue,
} from "../lib/e2e-scheduler.ts";

const DEFAULT_LIMITS: E2eLimits = { workers: 3, bedrock: 1, kiro: 1, ide: 1 };

function task(
  file: string,
  estimatedSeconds: number,
  resources: E2eResource[] = [],
  exclusive = false,
): E2eTask {
  return { file, estimatedSeconds, resources, exclusive };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** All progress is controlled by promises, with no sleeps or elapsed-time thresholds. */
function controlledQueue(tasks: E2eTask[], limits = DEFAULT_LIMITS) {
  const gates = new Map(tasks.map(({ file }) => [file, deferred()]));
  const started = new Map(tasks.map(({ file }) => [file, deferred()]));
  const finished = new Map(tasks.map(({ file }) => [file, deferred()]));
  const launches: { file: string; worker: number }[] = [];
  const events: E2eQueueEvent[] = [];
  const queue = runE2eQueue(tasks, limits, (entry, worker) => {
    launches.push({ file: entry.file, worker });
    started.get(entry.file)!.resolve();
    return gates.get(entry.file)!.promise;
  }, (event) => {
    events.push(event);
    if (event.kind === "finish") finished.get(event.file)!.resolve();
  });
  // Attach rejection handling immediately; failing queues are asserted after drain.
  const outcome = queue.then(
    () => ({ kind: "fulfilled" as const }),
    (reason: unknown) => ({ kind: "rejected" as const, reason }),
  );
  return {
    queue,
    outcome,
    gates,
    launches,
    events,
    started: (file: string) => started.get(file)!.promise,
    finished: (file: string) => finished.get(file)!.promise,
    async cleanup() {
      for (const gate of gates.values()) gate.resolve();
      await outcome;
    },
  };
}

/** Reconstruct occupancy from the public events, independently of the scheduler. */
function expectEventContract(
  events: E2eQueueEvent[],
  tasks: E2eTask[],
  limits: E2eLimits,
): void {
  const byFile = new Map(tasks.map((entry) => [entry.file, entry]));
  const active = new Map<number, E2eQueueEvent>();
  const starts = new Map<string, E2eQueueEvent>();
  const finishes = new Set<string>();
  const used: Record<E2eResource, number> = { bedrock: 0, kiro: 0, ide: 0 };
  for (const event of events) {
    const entry = byFile.get(event.file);
    expect(entry).toBeDefined();
    expect(event.resources).toEqual(entry!.resources);
    expect(Number.isInteger(event.worker)).toBe(true);
    expect(event.worker).toBeGreaterThanOrEqual(1);
    expect(event.worker).toBeLessThanOrEqual(limits.workers);
    expect(Number.isFinite(event.queuedMs)).toBe(true);
    expect(event.queuedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(event.elapsedMs)).toBe(true);
    expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
    if (event.kind === "start") {
      expect(starts.has(event.file)).toBe(false);
      expect(active.has(event.worker)).toBe(false);
      expect(event.elapsedMs).toBe(0);
      if (entry!.exclusive) expect(active.size).toBe(0);
      for (const other of active.values()) {
        expect(byFile.get(other.file)!.exclusive).not.toBe(true);
      }
      starts.set(event.file, event);
      active.set(event.worker, event);
      for (const resource of event.resources) used[resource]++;
    } else {
      expect(finishes.has(event.file)).toBe(false);
      expect(active.get(event.worker)?.file).toBe(event.file);
      expect(event.queuedMs).toBe(starts.get(event.file)!.queuedMs);
      finishes.add(event.file);
      active.delete(event.worker);
      for (const resource of event.resources) used[resource]--;
    }
    expect(event.running).toBe(active.size);
    expect(active.size).toBeLessThanOrEqual(limits.workers);
    for (const resource of ["bedrock", "kiro", "ide"] as const) {
      expect(used[resource]).toBeGreaterThanOrEqual(0);
      expect(used[resource]).toBeLessThanOrEqual(limits[resource]);
    }
  }
  expect(active.size).toBe(0);
  expect(used).toEqual({ bedrock: 0, kiro: 0, ide: 0 });
  expect([...starts.keys()].sort()).toEqual([...byFile.keys()].sort());
  expect([...finishes].sort()).toEqual([...byFile.keys()].sort());
}

describe("bounded E2E queue", () => {
  test("serial groups preserve unrelated overlap and release their slot after completion", async () => {
    const tasks = [
      { ...task("codex-a", 100, ["bedrock"]), serialGroup: "windows-codex" },
      { ...task("codex-b", 90, ["bedrock"]), serialGroup: "windows-codex" },
      task("claude", 80, ["bedrock"]),
      task("kiro", 70, ["kiro"]),
    ];
    const limits = { ...DEFAULT_LIMITS, workers: 4, bedrock: 3 };
    const run = controlledQueue(tasks, limits);
    try {
      await Promise.all(["codex-a", "claude", "kiro"].map(run.started));
      expect(run.launches.map(({ file }) => file)).toEqual(["codex-a", "claude", "kiro"]);
      run.gates.get("codex-a")!.resolve();
      await run.started("codex-b");
      expect(run.launches.map(({ file }) => file)).toEqual(["codex-a", "claude", "kiro", "codex-b"]);
      await run.cleanup();
      await run.queue;
      expectEventContract(run.events, tasks, limits);
    } finally {
      await run.cleanup();
    }
  });

  test("longest estimates go first with lexical ties, without mutating inputs", async () => {
    const tasks = [
      task("z.test.ts", 2),
      task("short.test.ts", 0.25),
      task("a.test.ts", 9),
      task("Z.test.ts", 9),
      task("A.test.ts", 9),
      task("c.test.ts", 2),
    ];
    const originalFiles = tasks.map(({ file }) => file);
    Object.freeze(tasks);
    for (const entry of tasks) {
      Object.freeze(entry.resources);
      Object.freeze(entry);
    }
    const order: string[] = [];
    const events: E2eQueueEvent[] = [];
    const limits = { ...DEFAULT_LIMITS, workers: 1 };
    await runE2eQueue(tasks, limits, async (entry, worker) => {
      order.push(entry.file);
      expect(worker).toBe(1);
      expect(tasks.includes(entry)).toBe(true);
    }, (event) => { events.push(event); });
    expect(order).toEqual([
      "A.test.ts", "Z.test.ts", "a.test.ts", "c.test.ts", "z.test.ts", "short.test.ts",
    ]);
    expect(tasks.map(({ file }) => file)).toEqual(originalFiles);
    expectEventContract(events, tasks, limits);
  });

  test("overlaps real executions, caps workers, reuses IDs, and runs every file once", async () => {
    const tasks = ["a", "b", "c", "d", "e"].map((file, index) => task(file, 10 - index));
    const run = controlledQueue(tasks);
    try {
      await Promise.all(["a", "b", "c"].map(run.started));
      // These three execute promises are all still unresolved.
      expect(run.launches).toEqual([
        { file: "a", worker: 1 }, { file: "b", worker: 2 }, { file: "c", worker: 3 },
      ]);
      expect(run.events.every(({ kind }) => kind === "start")).toBe(true);

      run.gates.get("b")!.resolve();
      await run.started("d");
      expect(run.launches.at(-1)).toEqual({ file: "d", worker: 2 });
      expect(run.launches).toHaveLength(4);
      run.gates.get("a")!.resolve();
      await run.started("e");
      expect(run.launches.at(-1)).toEqual({ file: "e", worker: 1 });
      await run.cleanup();
      await run.queue;

      expect(run.launches.map(({ file }) => file).sort()).toEqual(["a", "b", "c", "d", "e"]);
      expectEventContract(run.events, tasks, DEFAULT_LIMITS);
    } finally {
      await run.cleanup();
    }
  });

  test("backfills every available pool and reserves multi-resource tasks atomically", async () => {
    const limits = { workers: 4, bedrock: 2, kiro: 1, ide: 1 };
    const tasks = [
      task("a", 100, ["bedrock", "kiro"]),
      task("b", 90, ["bedrock", "kiro"]),
      task("c", 80, ["bedrock"]),
      task("d", 70, ["bedrock"]),
      task("e", 60, ["kiro"]),
      task("f", 50, ["ide"]),
      task("g", 40, ["ide"]),
      task("h", 30),
      task("i", 20),
    ];
    const run = controlledQueue(tasks, limits);
    try {
      await Promise.all(["a", "c", "f", "h"].map(run.started));
      expect(run.launches).toEqual([
        { file: "a", worker: 1 }, { file: "c", worker: 2 },
        { file: "f", worker: 3 }, { file: "h", worker: 4 },
      ]);
      // b is waiting for kiro; it must not reserve bedrock and block c or d.
      for (const [completed, next, worker] of [
        ["h", "i", 4],
        ["c", "d", 2],
        ["f", "g", 3],
        ["a", "b", 1],
        ["b", "e", 1],
      ] as const) {
        const before = run.launches.length;
        run.gates.get(completed)!.resolve();
        await run.started(next);
        expect(run.launches).toHaveLength(before + 1);
        expect(run.launches.at(-1)).toEqual({ file: next, worker });
      }
      await run.cleanup();
      await run.queue;
      expect(run.launches.map(({ file }) => file).sort()).toEqual(tasks.map(({ file }) => file));
      expectEventContract(run.events, tasks, limits);
    } finally {
      await run.cleanup();
    }
  });

  test("exclusive tasks wait for all active executions and run alone", async () => {
    const tasks = [
      task("a", 100, ["bedrock"]),
      task("exclusive-b", 90, ["bedrock", "kiro", "ide"], true),
      task("c", 80, ["kiro"]),
      task("exclusive-d", 70, [], true),
      task("e", 60, ["ide"]),
    ];
    const run = controlledQueue(tasks);
    try {
      await Promise.all(["a", "c", "e"].map(run.started));
      expect(run.launches.map(({ file }) => file)).toEqual(["a", "c", "e"]);
      for (const file of ["a", "c"]) {
        run.gates.get(file)!.resolve();
        await run.finished(file);
        expect(run.launches).toHaveLength(3);
      }
      run.gates.get("e")!.resolve();
      await run.started("exclusive-b");
      expect(run.launches.at(-1)).toEqual({ file: "exclusive-b", worker: 1 });
      expect(run.launches).toHaveLength(4);
      run.gates.get("exclusive-b")!.resolve();
      await run.started("exclusive-d");
      expect(run.launches.at(-1)).toEqual({ file: "exclusive-d", worker: 1 });
      await run.cleanup();
      await run.queue;
      expectEventContract(run.events, tasks, DEFAULT_LIMITS);
    } finally {
      await run.cleanup();
    }
  });

  test("an exclusive task at the head prevents any parallel dispatch until release", async () => {
    const tasks = [
      task("exclusive", 100, [], true),
      task("bedrock", 90, ["bedrock"]),
      task("kiro", 80, ["kiro"]),
    ];
    const run = controlledQueue(tasks);
    try {
      await run.started("exclusive");
      expect(run.launches).toEqual([{ file: "exclusive", worker: 1 }]);
      run.gates.get("exclusive")!.resolve();
      await Promise.all(["bedrock", "kiro"].map(run.started));
      expect(run.launches.slice(1)).toEqual([
        { file: "bedrock", worker: 1 }, { file: "kiro", worker: 2 },
      ]);
      await run.cleanup();
      await run.queue;
      expectEventContract(run.events, tasks, DEFAULT_LIMITS);
    } finally {
      await run.cleanup();
    }
  });

  test("failure releases reservations, drains all active work, and stops pending tasks", async () => {
    const tasks = [
      task("a", 100, ["bedrock"]),
      task("b", 90, ["kiro"]),
      task("c", 80, ["ide"]),
      task("pending", 70),
    ];
    const firstFailure = new Error("first execution failed");
    const run = controlledQueue(tasks);
    let finishedAtRejection: string[] = [];
    const rejection = run.queue.catch((reason: unknown) => {
      finishedAtRejection = run.events.filter(({ kind }) => kind === "finish").map(({ file }) => file);
      return reason;
    });
    try {
      await Promise.all(["a", "b", "c"].map(run.started));
      run.gates.get("a")!.reject(firstFailure);
      await run.finished("a");
      expect(run.events.at(-1)).toMatchObject({ kind: "finish", file: "a", running: 2 });
      expect(run.launches).toHaveLength(3);
      run.gates.get("b")!.reject(new Error("later execution also failed"));
      await run.finished("b");
      expect(run.events.at(-1)).toMatchObject({ kind: "finish", file: "b", running: 1 });
      expect(run.launches).toHaveLength(3);
      run.gates.get("c")!.resolve();
      expect(await rejection).toBe(firstFailure);
      expect(await run.outcome).toEqual({ kind: "rejected", reason: firstFailure });
      expect(finishedAtRejection.sort()).toEqual(["a", "b", "c"]);
      expect(run.launches.map(({ file }) => file)).toEqual(["a", "b", "c"]);
      expectEventContract(run.events, tasks.slice(0, 3), DEFAULT_LIMITS);
    } finally {
      await run.cleanup();
    }
  });

  test("a synchronous execute throw rejects and does not dispatch another task", async () => {
    const failure = new Error("synchronous failure");
    const tasks = [task("first", 2, ["bedrock", "kiro"], true), task("pending", 1)];
    const launches: string[] = [];
    const events: E2eQueueEvent[] = [];
    await expect(runE2eQueue(tasks, DEFAULT_LIMITS, (entry) => {
      launches.push(entry.file);
      throw failure;
    }, (event) => { events.push(event); })).rejects.toBe(failure);
    expect(launches).toEqual(["first"]);
    expectEventContract(events, tasks.slice(0, 1), DEFAULT_LIMITS);
  });

  test.each([undefined, null, false, 0, ""])("does not mistake rejection %p for success", async (reason) => {
    const launches: string[] = [];
    const outcome = await runE2eQueue(
      [task("first", 2), task("pending", 1)],
      { ...DEFAULT_LIMITS, workers: 1 },
      (entry) => {
        launches.push(entry.file);
        return Promise.reject(reason);
      },
    ).then(
      () => ({ kind: "fulfilled" }),
      (error: unknown) => ({ kind: "rejected", reason: error }),
    );
    expect(outcome).toEqual({ kind: "rejected", reason });
    expect(launches).toEqual(["first"]);
  });

  test.each(["start", "finish"] as const)("a throwing %s observer also drains active work and rejects", async (kind) => {
    const tasks = [task("a", 3), task("b", 2), task("pending", 1)];
    const gates = { a: deferred(), b: deferred() };
    const bFinished = deferred();
    const failure = new Error("event observer failed");
    const events: E2eQueueEvent[] = [];
    const launches: string[] = [];
    const queue = runE2eQueue(tasks, { ...DEFAULT_LIMITS, workers: 2 }, (entry) => {
      launches.push(entry.file);
      return gates[entry.file as keyof typeof gates].promise;
    }, (event) => {
      events.push(event);
      if (event.kind === "finish" && event.file === "b") bFinished.resolve();
      if (event.kind === kind && event.file === "b") throw failure;
    });
    const outcome = queue.then(
      () => ({ kind: "fulfilled" }),
      (reason: unknown) => ({
        kind: "rejected",
        reason,
        finished: events.filter((event) => event.kind === "finish").map((event) => event.file),
      }),
    );
    try {
      gates.b.resolve();
      await bFinished.promise;
      gates.a.resolve();
      expect(await outcome).toEqual({ kind: "rejected", reason: failure, finished: ["b", "a"] });
      expect(launches).toEqual(kind === "start" ? ["a"] : ["a", "b"]);
      expectEventContract(events, tasks.slice(0, 2), { ...DEFAULT_LIMITS, workers: 2 });
    } finally {
      gates.a.resolve();
      gates.b.resolve();
      await outcome;
    }
  });

  test("event resource arrays cannot mutate a task or its reservation", async () => {
    const tasks = [task("a", 2, ["bedrock"]), task("b", 1, ["bedrock"])];
    const seen: E2eQueueEvent[] = [];
    const launches: string[] = [];
    await runE2eQueue(tasks, DEFAULT_LIMITS, async (entry) => {
      launches.push(entry.file);
      expect(entry.resources).toEqual(["bedrock"]);
    }, (event) => {
      seen.push({ ...event, resources: [...event.resources] });
      event.resources.length = 0;
    });
    expect(launches).toEqual(["a", "b"]);
    expectEventContract(seen, tasks, DEFAULT_LIMITS);
  });
});

describe("E2E queue validation", () => {
  async function expectInvalid(tasks: E2eTask[], limits: E2eLimits, message: string) {
    let executions = 0;
    const events: E2eQueueEvent[] = [];
    await expect(runE2eQueue(tasks, limits, async () => {
      executions++;
    }, (event) => { events.push(event); })).rejects.toThrow(message);
    expect(executions).toBe(0);
    expect(events).toEqual([]);
  }

  for (const key of ["workers", "bedrock", "kiro", "ide"] as const) {
    test.each([0, -1, 1.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
      `rejects invalid ${key} limit %p before dispatch`,
      async (value) => {
        await expectInvalid([task("valid", 1)], { ...DEFAULT_LIMITS, [key]: value }, key);
      },
    );
  }

  test.each([0, -1, Number.NaN, Infinity, -Infinity])("rejects invalid estimate %p before any dispatch", async (estimate) => {
    await expectInvalid(
      [task("valid-first", 1), task("invalid-last", estimate)],
      DEFAULT_LIMITS,
      "estimatedSeconds must be positive and finite",
    );
  });

  test("duplicate filenames reject the whole queue before any execution", async () => {
    await expectInvalid(
      [task("same", 2, ["bedrock"]), task("same", 1, ["kiro"])],
      DEFAULT_LIMITS,
      "Duplicate E2E task file: same",
    );
  });

  test.each(["bedrock", "kiro", "ide"] as const)("rejects duplicate %s declarations before dispatch", async (resource) => {
    await expectInvalid(
      [task("valid-first", 2), task("duplicate", 1, [resource, resource])],
      DEFAULT_LIMITS,
      `Duplicate E2E resource ${resource}`,
    );
  });

  test("unknown runtime resources reject instead of leaving an unschedulable task", async () => {
    await expectInvalid(
      [task("unknown", 1, ["unknown" as E2eResource])],
      DEFAULT_LIMITS,
      "Unknown E2E resource",
    );
  });

  test("accepts safe integer limit maxima and positive finite fractional estimates", async () => {
    const limits: E2eLimits = {
      workers: Number.MAX_SAFE_INTEGER,
      bedrock: Number.MAX_SAFE_INTEGER,
      kiro: Number.MAX_SAFE_INTEGER,
      ide: Number.MAX_SAFE_INTEGER,
    };
    const tasks = [
      task("small", Number.MIN_VALUE),
      task("large", Number.MAX_VALUE, ["bedrock", "kiro", "ide"]),
    ];
    const launches: { file: string; worker: number }[] = [];
    const events: E2eQueueEvent[] = [];
    await runE2eQueue(tasks, limits, async (entry, worker) => {
      launches.push({ file: entry.file, worker });
    }, (event) => { events.push(event); });
    expect(launches).toEqual([{ file: "large", worker: 1 }, { file: "small", worker: 2 }]);
    expectEventContract(events, tasks, limits);
  });

  test("an empty queue resolves without executions or events", async () => {
    let executions = 0;
    const events: E2eQueueEvent[] = [];
    await runE2eQueue([], DEFAULT_LIMITS, async () => {
      executions++;
    }, (event) => { events.push(event); });
    expect(executions).toBe(0);
    expect(events).toEqual([]);
  });
});
