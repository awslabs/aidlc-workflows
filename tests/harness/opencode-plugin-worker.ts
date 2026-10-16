// opencode-plugin-worker.ts - opencode's process, as far as AI-DLC's plugin sees it.
//
// opencode loads .opencode/plugin/aidlc-opencode-adapter.ts into its own
// process and awaits each hook. The scope run is synchronous, so the
// OpencodeScopeHost (scope-hosts.ts) runs the plugin here, in a worker thread,
// and waits on each call: the request comes by message, the answer goes back
// through the shared buffer, and the plugin keeps its own state (the chats it
// started, their human turns, which session is a helper's) from call to call.
// The client is opencode's, reduced to what the plugin calls: a session's
// parent, the nudge a turn end sends, and the settings.

import { parentPort, workerData } from "node:worker_threads";

interface WorkerData {
  sab: SharedArrayBuffer;
  env: Record<string, string | undefined>;
}

type Hooks = Record<string, (input: unknown, output?: unknown) => Promise<void>>;

const { sab, env } = workerData as WorkerData;
const flag = new Int32Array(sab, 0, 2);
const bytes = new Uint8Array(sab, 8);

// The plugin's hooks run as children with this process's environment, as in opencode.
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);

const parents = new Map<string, string>();
let nudges: string[] = [];
let plugin: Hooks | null = null;

const client = {
  session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: parents.has(path.id) ? { parentID: parents.get(path.id) } : {} }),
    prompt: async ({ body }: { body: { parts: { text: string }[] } }) => {
      nudges.push(body.parts.map((part) => part.text).join("\n"));
      return {};
    },
  },
  config: { get: async () => ({ data: {} }) },
  tui: { showToast: async () => ({}) },
};

function answer(value: unknown): void {
  const out = new TextEncoder().encode(JSON.stringify(value));
  if (out.length > bytes.length) throw new Error(`the plugin's answer is ${out.length} bytes, over the bridge's ${bytes.length}`);
  bytes.set(out);
  Atomics.store(flag, 1, out.length);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

type Request =
  | { op: "start"; plugin: string; directory: string }
  | { op: "parent"; child: string; parent: string }
  | { op: "hook"; name: string; input: unknown; output?: unknown };

parentPort?.on("message", async (request: Request) => {
  try {
    if (request.op === "start") {
      const factory = (await import(request.plugin)).default as (input: unknown) => Promise<Hooks>;
      plugin = await factory({ client, directory: request.directory });
      answer({ ok: true });
    } else if (request.op === "parent") {
      parents.set(request.child, request.parent);
      answer({ ok: true });
    } else {
      if (!plugin) throw new Error("the plugin is not loaded");
      nudges = [];
      const hook = plugin[request.name];
      let refused: string | null = null;
      try {
        if (hook) await hook(request.input, request.output);
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      answer({ ok: true, refused, output: request.output ?? null, nudges });
    }
  } catch (error) {
    answer({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
});
