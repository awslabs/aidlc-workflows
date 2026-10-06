export type E2eResource = "bedrock" | "kiro" | "ide";

export interface E2eTask {
  file: string;
  resources: E2eResource[];
  estimatedSeconds: number;
  exclusive?: boolean;
  /** Tasks in the same group run one at a time; unrelated work can overlap. */
  serialGroup?: string;
}

export interface E2eLimits {
  workers: number;
  bedrock: number;
  kiro: number;
  ide: number;
}

export type E2eQueueEvent = {
  kind: "start" | "finish";
  file: string;
  worker: number;
  resources: E2eResource[];
  /** Time from queue entry to start; unchanged on the matching finish. */
  queuedMs: number;
  /** Execution duration; zero on start. */
  elapsedMs: number;
  /** Active tasks after this event's reservation or release. */
  running: number;
};

/**
 * Run the longest ready task, breaking ties by file's lexical (code unit) order.
 * Each declared resource consumes one slot. Blocked tasks, including an exclusive
 * task waiting for an idle queue, allow shorter ready tasks to backfill.
 *
 * Execute is called once per dispatched task with the lowest available worker ID.
 * A rejection or synchronous throw stops dispatch, drains active tasks, and rejects
 * with the first failure (including a falsy rejection reason). Event callback
 * exceptions follow the same policy. Finish events describe release, not success;
 * execute's resolved value is never inspected for assertion results.
 */
export async function runE2eQueue(
  tasks: E2eTask[],
  limits: E2eLimits,
  execute: (task: E2eTask, worker: number) => Promise<void>,
  event?: (event: E2eQueueEvent) => void,
): Promise<void> {
  const enqueuedAt = performance.now();
  const caps = { ...limits };
  for (const key of ["workers", "bedrock", "kiro", "ide"] as const) {
    if (!Number.isSafeInteger(caps[key]) || caps[key] <= 0) {
      throw new Error(`E2E limit ${key} must be a finite positive safe integer`);
    }
  }

  const files = new Set<string>();
  // Snapshot scheduling metadata so callbacks cannot change reservations.
  const pending = tasks.map((task) => {
    if (files.has(task.file)) {
      throw new Error(`Duplicate E2E task file: ${task.file}`);
    }
    files.add(task.file);
    if (!Number.isFinite(task.estimatedSeconds) || task.estimatedSeconds <= 0) {
      throw new Error(`E2E task ${task.file} estimatedSeconds must be positive and finite`);
    }
    if (task.serialGroup !== undefined &&
      (typeof task.serialGroup !== "string" || task.serialGroup.trim() === "")) {
      throw new Error(`E2E task ${task.file} serialGroup must be a nonempty string`);
    }
    const resources = new Set<E2eResource>();
    for (const resource of task.resources) {
      if (resource !== "bedrock" && resource !== "kiro" && resource !== "ide") {
        throw new Error(`Unknown E2E resource ${resource} for ${task.file}`);
      }
      if (resources.has(resource)) {
        throw new Error(`Duplicate E2E resource ${resource} for ${task.file}`);
      }
      resources.add(resource);
    }
    return {
      task,
      file: task.file,
      resources: [...resources],
      estimatedSeconds: task.estimatedSeconds,
      exclusive: task.exclusive === true,
      serialGroup: task.serialGroup,
    };
  }).sort((a, b) =>
    b.estimatedSeconds - a.estimatedSeconds ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );
  if (pending.length === 0) return;

  await new Promise<void>((resolve, reject) => {
    const workers = new Set<number>();
    const used: Record<E2eResource, number> = { bedrock: 0, kiro: 0, ide: 0 };
    const activeGroups = new Set<string>();
    let exclusiveRunning = false;
    let failed = false;
    let failure: unknown;

    function recordFailure(reason: unknown): void {
      if (!failed) {
        failed = true;
        failure = reason;
      }
    }

    function start(entry: (typeof pending)[number], worker: number): void {
      workers.add(worker);
      for (const resource of entry.resources) used[resource]++;
      if (entry.exclusive) exclusiveRunning = true;
      if (entry.serialGroup) activeGroups.add(entry.serialGroup);
      const startedAt = performance.now();
      const queuedMs = startedAt - enqueuedAt;

      function emit(kind: E2eQueueEvent["kind"]): void {
        event?.({
          kind,
          file: entry.file,
          worker,
          resources: [...entry.resources],
          queuedMs,
          elapsedMs: kind === "start" ? 0 : performance.now() - startedAt,
          running: workers.size,
        });
      }

      void (async () => {
        try {
          emit("start");
          await execute(entry.task, worker);
        } catch (reason) {
          recordFailure(reason);
        } finally {
          workers.delete(worker);
          for (const resource of entry.resources) used[resource]--;
          if (entry.exclusive) exclusiveRunning = false;
          if (entry.serialGroup) activeGroups.delete(entry.serialGroup);
          try {
            emit("finish");
          } catch (reason) {
            recordFailure(reason);
          }
          pump();
        }
      })();
    }

    function pump(): void {
      while (!failed && !exclusiveRunning && workers.size < caps.workers) {
        const index = pending.findIndex((entry) =>
          (!entry.exclusive || workers.size === 0) &&
          (!entry.serialGroup || !activeGroups.has(entry.serialGroup)) &&
          entry.resources.every((resource) => used[resource] < caps[resource]),
        );
        if (index === -1) break;
        const [entry] = pending.splice(index, 1);
        // Allocate IDs lazily: even MAX_SAFE_INTEGER workers is a valid limit.
        let worker = 1;
        while (workers.has(worker)) worker++;
        start(entry, worker);
      }
      if (workers.size === 0) {
        if (failed) reject(failure);
        else if (pending.length === 0) resolve();
        else reject(new Error("E2E queue has pending tasks but no runnable task"));
      }
    }

    pump();
  });
}
