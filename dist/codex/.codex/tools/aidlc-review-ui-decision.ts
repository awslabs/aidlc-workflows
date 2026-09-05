import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveProjectAidlcPath } from "./aidlc-review-ui-render.ts";
import {
  DECISION_PREFIX,
  decisionFileName,
  nextSequence,
  pendingFeedback,
  stageReviewUiDir,
  type CurrentPointer,
  type DecisionSubmission,
  type ReviewDecision,
} from "./aidlc-review-ui-shared.ts";

interface DecisionRequestBody {
  stage: string;
  unit: string | null;
  revision: number;
  decision: ReviewDecision;
  notes?: string;
}

export interface DecisionHandlerContext {
  projectDir: string;
  stateContext: {
    current: CurrentPointer | null;
  };
  appendHumanTurn(file: string): void | Promise<void>;
}

const MAX_DECISION_BODY_BYTES = 64 * 1024;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function parseDecisionBody(value: unknown): DecisionRequestBody | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed: Record<string, true> = {
    stage: true,
    unit: true,
    revision: true,
    decision: true,
    notes: true,
  };
  if (Object.keys(body).some((key) => !allowed[key])) return null;
  if (
    typeof body.stage !== "string" ||
    body.stage.length === 0 ||
    (body.unit !== null && typeof body.unit !== "string") ||
    !Number.isInteger(body.revision) ||
    (body.revision as number) < 0 ||
    (body.decision !== "approve" && body.decision !== "request-changes") ||
    (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string")
  ) {
    return null;
  }
  return {
    stage: body.stage,
    unit: body.unit,
    revision: body.revision as number,
    decision: body.decision,
    ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
  };
}

export async function handleDecision(
  request: Request,
  context: DecisionHandlerContext,
): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_DECISION_BODY_BYTES) {
    return jsonError(413, "request body too large");
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return jsonError(400, "invalid JSON");
  }
  if (new TextEncoder().encode(text).byteLength > MAX_DECISION_BODY_BYTES) {
    return jsonError(413, "request body too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return jsonError(400, "invalid JSON");
  }
  const body = parseDecisionBody(value);
  if (!body) return jsonError(400, "invalid decision body");

  const current = context.stateContext.current;
  if (
    !current ||
    current.stage !== body.stage ||
    current.unit !== body.unit ||
    current.revision !== body.revision
  ) {
    return jsonError(409, "review changed; reload");
  }
  if (current.state !== "awaiting-approval") {
    return jsonError(409, "review is not awaiting approval");
  }
  if (!current.stage_dir) return jsonError(409, "current review has no stage directory");

  const stageDir = resolveProjectAidlcPath(context.projectDir, current.stage_dir);
  const reviewDir = stageReviewUiDir(stageDir);
  mkdirSync(reviewDir, { recursive: true });
  const latestFeedback = pendingFeedback(stageDir)
    .filter((item) =>
      item.frontmatter.stage === body.stage &&
      item.frontmatter.unit === body.unit &&
      item.frontmatter.revision === body.revision
    )
    .at(-1)?.file ?? null;
  const submission: DecisionSubmission = {
    version: 1,
    stage: body.stage,
    unit: body.unit,
    revision: body.revision,
    decision: body.decision,
    notes: body.notes?.trim() || null,
    feedback_file: latestFeedback,
    created: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  // The Stop hook watches this directory and must never observe a half-written
  // decision: write the full content to a private temp file, then publish it
  // under the numbered name with link(2), which is exclusive (EEXIST on a race).
  const payload = `${JSON.stringify(submission, null, 2)}\n`;
  const temp = join(reviewDir, `.decision-${process.pid}-${Date.now()}.tmp`);
  const descriptor = openSync(temp, "wx");
  try {
    writeFileSync(descriptor, payload, "utf-8");
  } finally {
    closeSync(descriptor);
  }
  let sequence = nextSequence(reviewDir, DECISION_PREFIX);
  try {
    while (true) {
      const file = decisionFileName(sequence++);
      const path = join(reviewDir, file);
      try {
        linkSync(temp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      await context.appendHumanTurn(file);
      return Response.json({ file });
    }
  } finally {
    rmSync(temp, { force: true });
  }
}
