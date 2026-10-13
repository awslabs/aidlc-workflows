// covers: function:hookChildEnv, function:withInheritedHookWorkflow, function:recordHookBootstrap
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureHookWorkflow, enterHookWorkflow, hookChildEnv, resolveWorkflowSelection, runInHookWorkflow, sessionsDir,
  withHookWorkflowMutation, withInheritedHookWorkflow, writeSessionBinding, writeSessionIntentUuid, readSessionBinding,
} from "../../core/tools/aidlc-lib.ts";
import { beginHookBootstrapCapture, recordHookBootstrap } from "../../core/tools/aidlc-hook-bootstrap.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const SESSION = "01995000-7a11-7000-8000-00000000d006";

function fixture() {
  const project = mkdtempSync(join(tmpdir(), "aidlc-child-context-"));
  roots.push(project);
  const intents = join(project, "aidlc", "spaces", "default", "intents");
  for (const intent of ["a", "b"]) {
    mkdirSync(join(intents, intent), { recursive: true });
    writeFileSync(join(intents, intent, "aidlc-state.md"), "- **Status**: Running\n");
  }
  writeFileSync(join(intents, "active-intent"), "a\n");
  writeSessionBinding(project, SESSION, "default", "a", "create");
  const workflow = enterHookWorkflow(project, SESSION);
  workflow.restore();
  return { project, intents, workflow };
}

function withContext<T>(encoded: string | undefined, run: () => T): T {
  const prior = process.env.AIDLC_HOOK_WORKFLOW_CONTEXT;
  if (encoded === undefined) delete process.env.AIDLC_HOOK_WORKFLOW_CONTEXT;
  else process.env.AIDLC_HOOK_WORKFLOW_CONTEXT = encoded;
  try { return run(); }
  finally {
    if (prior === undefined) delete process.env.AIDLC_HOOK_WORKFLOW_CONTEXT;
    else process.env.AIDLC_HOOK_WORKFLOW_CONTEXT = prior;
  }
}

describe("captured hook context is scoped to the child hook entry", () => {
  test("a changed binding and cursor cannot retarget the captured event; ordinary commands still resolve B", () => {
    const f = fixture();
    const child = hookChildEnv(f.project, SESSION, {}, f.workflow);
    writeSessionBinding(f.project, SESSION, "default", "b", "switch");
    writeFileSync(join(f.intents, "active-intent"), "b\n");
    withContext(child.AIDLC_HOOK_WORKFLOW_CONTEXT, () => {
      expect(resolveWorkflowSelection(f.project).intent).toBe("b");
      withInheritedHookWorkflow(f.project, () => {
        const workflow = enterHookWorkflow(f.project, SESSION);
        try {
          expect(workflow.selection?.intent).toBe("a");
          expect(workflow.participation).toBe("participant");
          expect(withHookWorkflowMutation(f.project, workflow, () => resolveWorkflowSelection(f.project).intent)).toBe("a");
        } finally { workflow.restore(); }
      });
      expect(resolveWorkflowSelection(f.project).intent).toBe("b");
    });
  });

  test("canonical closure and independent mode each prohibit child mutations", () => {
    const f = fixture();
    for (const mode of [undefined, "independent"] as const) {
      writeFileSync(join(f.intents, "a", "aidlc-state.md"), `- **Status**: ${mode ? "Running" : "Completed"}\n`);
      const child = hookChildEnv(f.project, SESSION, {}, { ...f.workflow, mode });
      withContext(child.AIDLC_HOOK_WORKFLOW_CONTEXT, () => withInheritedHookWorkflow(f.project, () => {
        const workflow = enterHookWorkflow(f.project, SESSION);
        try {
          expect(workflow.lifecycle).toBe(mode ? "running" : "completed");
          expect(workflow.mode).toBe(mode);
          let called = false;
          expect(withHookWorkflowMutation(f.project, workflow, () => { called = true; })).toBeUndefined();
          expect(called).toBe(false);
        } finally { workflow.restore(); }
      }));
    }
  });

  test("malformed or foreign-project transport cannot fall through to live cursor work", () => {
    const f = fixture();
    const encoded = hookChildEnv(f.project, SESSION, {}, f.workflow).AIDLC_HOOK_WORKFLOW_CONTEXT!;
    for (const context of ["{", JSON.stringify({ ...JSON.parse(encoded), projectDir: `${f.project}/elsewhere` })]) {
      withContext(context, () => withInheritedHookWorkflow(f.project, () => {
        const workflow = enterHookWorkflow(f.project, SESSION);
        expect(workflow.selection).toBeNull();
        expect(workflow.mode).toBe("independent");
        expect(withHookWorkflowMutation(f.project, workflow, () => "forbidden")).toBeUndefined();
      }));
    }
  });

  test("ordinary child commands do not inherit ambient transport implicitly", () => {
    const f = fixture();
    withContext(hookChildEnv(f.project, SESSION, {}, f.workflow).AIDLC_HOOK_WORKFLOW_CONTEXT, () => {
      expect(hookChildEnv(f.project, SESSION).AIDLC_HOOK_WORKFLOW_CONTEXT).toBeUndefined();
    });
  });

  test("an unresolved parent retains authority evaluation without falling back to a new cursor", () => {
    const f = fixture();
    const unresolved = {
      ...f.workflow, selection: null, participation: "indeterminate" as const,
      lifecycle: "unreadable" as const,
    };
    withContext(hookChildEnv(f.project, SESSION, {}, unresolved).AIDLC_HOOK_WORKFLOW_CONTEXT, () =>
      withInheritedHookWorkflow(f.project, () => {
        const workflow = enterHookWorkflow(f.project, SESSION);
        expect(workflow.selection).toBeNull();
        expect(workflow.mode).toBeUndefined();
        expect(() => resolveWorkflowSelection(f.project)).toThrow("captured workflow selection");
        expect(withHookWorkflowMutation(f.project, workflow, () => "forbidden")).toBeUndefined();
      }));
  });

  test("a child payload for a different chat cannot reuse the captured event", () => {
    const f = fixture();
    const other = "01995000-7a11-7000-8000-00000000d007";
    writeSessionBinding(f.project, other, "default", "b", "create");
    withContext(hookChildEnv(f.project, SESSION, {}, f.workflow).AIDLC_HOOK_WORKFLOW_CONTEXT, () =>
      withInheritedHookWorkflow(f.project, () => {
        const workflow = enterHookWorkflow(f.project, other);
        expect(workflow.selection).toBeNull();
        expect(workflow.mode).toBe("independent");
      }));
  });

  test("prior-session reconciliation captures the previous chat without inheriting the current record", () => {
    const f = fixture();
    const prior = "01995000-7a11-7000-8000-00000000d008";
    writeSessionBinding(f.project, prior, "default", "b", "create");
    runInHookWorkflow(f.project, f.workflow, () => {
      const captured = captureHookWorkflow(f.project, prior);
      expect(captured.selection?.intent).toBe("b");
      expect(captured.selection?.sessionId).toBe(prior);
      expect(resolveWorkflowSelection(f.project).intent).toBe("a");
      const child = hookChildEnv(f.project, prior, {}, captured);
      writeSessionBinding(f.project, prior, "default", "a", "switch");
      withContext(child.AIDLC_HOOK_WORKFLOW_CONTEXT, () => withInheritedHookWorkflow(f.project, () => {
        const admitted = enterHookWorkflow(f.project, prior);
        try { expect(admitted.selection?.intent).toBe("b"); }
        finally { admitted.restore(); }
      }));
      expect(resolveWorkflowSelection(f.project).intent).toBe("a");
    });
  });

  test("only a resume captures a legacy stamp before the shared cursor, without writing a binding", () => {
    const f = fixture();
    rmSync(join(sessionsDir(f.project), `${SESSION}.binding.json`));
    const uuid = "00000000-0000-7000-8000-000000000001";
    writeFileSync(join(f.intents, "intents.json"), JSON.stringify([
      { uuid, slug: "a", dirName: "a", status: "in-flight" },
    ]));
    writeSessionIntentUuid(f.project, SESSION, uuid);
    writeFileSync(join(f.intents, "active-intent"), "b\n");
    for (const source of [undefined, "startup", "resume"]) {
      const workflow = enterHookWorkflow(f.project, SESSION, source === undefined ? {} : { sessionStartSource: source });
      try {
        expect(workflow.selection?.intent).toBe(source === "resume" ? "a" : "b");
        expect(workflow.resumedFromStamp).toBe(source === "resume" ? true : undefined);
        expect(workflow.participation).toBe("participant");
        expect(readSessionBinding(f.project, SESSION)).toBeNull();
      } finally { workflow.restore(); }
    }
  });

  test("a captured legacy resume survives a later binding and stamp switch", () => {
    const f = fixture();
    rmSync(join(sessionsDir(f.project), `${SESSION}.binding.json`));
    const a = "00000000-0000-7000-8000-000000000001";
    const b = "00000000-0000-7000-8000-000000000002";
    writeFileSync(join(f.intents, "intents.json"), JSON.stringify([
      { uuid: a, slug: "a", dirName: "a", status: "in-flight" },
      { uuid: b, slug: "b", dirName: "b", status: "in-flight" },
    ]));
    writeSessionIntentUuid(f.project, SESSION, a);
    writeFileSync(join(f.intents, "active-intent"), "b\n");
    const captured = enterHookWorkflow(f.project, SESSION, { sessionStartSource: "resume" });
    captured.restore();
    const child = hookChildEnv(f.project, SESSION, {}, captured);
    writeSessionBinding(f.project, SESSION, "default", "b", "switch");
    writeSessionIntentUuid(f.project, SESSION, b);
    withContext(child.AIDLC_HOOK_WORKFLOW_CONTEXT, () => withInheritedHookWorkflow(f.project, () => {
      const workflow = enterHookWorkflow(f.project, SESSION, { sessionStartSource: "resume" });
      try {
        expect(workflow.selection?.intent).toBe("a");
        expect(workflow.resumedFromStamp).toBe(true);
        expect(withHookWorkflowMutation(f.project, workflow, () => resolveWorkflowSelection(f.project).intent)).toBe("a");
        expect(readSessionBinding(f.project, SESSION)?.intent).toBe("b");
      } finally { workflow.restore(); }
    }));
  });
});

describe("independent bootstrap output transport", () => {
  test("only the matching event target is returned, then the private receipt is removed", () => {
    const f = fixture();
    const capture = beginHookBootstrapCapture(f.project, f.workflow.selection!);
    const prior = process.env.AIDLC_HOOK_BOOTSTRAP_CAPTURE;
    process.env.AIDLC_HOOK_BOOTSTRAP_CAPTURE = capture.env.AIDLC_HOOK_BOOTSTRAP_CAPTURE;
    try {
      recordHookBootstrap(f.project, { ...f.workflow.selection!, intent: "b" }, "wrong");
      expect(capture.read()).toBe("");
      recordHookBootstrap(f.project, f.workflow.selection!, "one-time setup notice");
      expect(capture.read()).toBe("one-time setup notice");
      capture.close();
      expect(capture.read()).toBe("");
    } finally {
      capture.close();
      if (prior === undefined) delete process.env.AIDLC_HOOK_BOOTSTRAP_CAPTURE;
      else process.env.AIDLC_HOOK_BOOTSTRAP_CAPTURE = prior;
    }
  });

  test("redirected session storage is neither read nor written through", () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "aidlc-bootstrap-outside-"));
    roots.push(outside);
    rmSync(sessionsDir(f.project), { recursive: true, force: true });
    symlinkSync(outside, sessionsDir(f.project), process.platform === "win32" ? "junction" : "dir");
    const capture = beginHookBootstrapCapture(f.project, f.workflow.selection!);
    const prior = process.env.AIDLC_HOOK_BOOTSTRAP_CAPTURE;
    process.env.AIDLC_HOOK_BOOTSTRAP_CAPTURE = capture.env.AIDLC_HOOK_BOOTSTRAP_CAPTURE;
    try {
      recordHookBootstrap(f.project, f.workflow.selection!, "no redirected write");
      expect(capture.read()).toBe("");
      expect(readdirSync(outside)).toEqual([]);
      writeFileSync(join(outside, "sentinel"), "unchanged");
      capture.close();
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("unchanged");
    } finally {
      if (prior === undefined) delete process.env.AIDLC_HOOK_BOOTSTRAP_CAPTURE;
      else process.env.AIDLC_HOOK_BOOTSTRAP_CAPTURE = prior;
    }
  });
});
