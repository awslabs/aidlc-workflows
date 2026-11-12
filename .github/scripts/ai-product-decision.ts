// Product choices inform the maintainer in AIDA's existing comment. They never
// determine the technical verdict, publish checks, or require approval commands.
import type { ChangedFileManifest, ReviewDiscussion } from "./ai-pr-review.ts";

export interface ProductChoice {
  change: string;
  before: string;
  after: string;
  question: string | null;
  decision: {
    summary: string;
    source: { kind: "comment" | "review" | "review-comment"; id: number; by: string };
  } | null;
  paths: string[];
}

export interface Assessment {
  base: string;
  head: string;
  status: "no-product-change" | "product-change";
  summary: string;
  decisions: ProductChoice[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("missing or oversized text");
  return value;
}

export function validateAssessment(value: unknown, manifest: ChangedFileManifest, discussion?: ReviewDiscussion): Assessment {
  const input = object(value);
  if (input.base !== manifest.base || input.head !== manifest.head) throw new Error("assessment revisions do not match");
  if (input.status !== "no-product-change" && input.status !== "product-change") throw new Error("invalid product status");
  if (!Array.isArray(input.decisions) || input.decisions.length > 20) throw new Error("invalid product decisions");
  const paths = new Set(manifest.files.map(file => file.path));
  const entries = discussion
    ? [...discussion.reviews, ...discussion.reviewComments, ...discussion.comments]
    : [];
  const decisions = input.decisions.map(value => {
    const choice = object(value);
    if (!Array.isArray(choice.paths) || choice.paths.length === 0 || choice.paths.length > 20
      || choice.paths.some(path => typeof path !== "string" || !paths.has(path))) {
      throw new Error("a product choice must cite changed files");
    }
    let decision: ProductChoice["decision"] = null;
    if (choice.decision !== null) {
      const judgment = object(choice.decision);
      const source = object(judgment.source);
      const entry = entries.find(entry => entry.kind === source.kind && entry.id === source.id && entry.actor.maintainer);
      if (!entry || entry.kind === "ai-review") throw new Error("product decision must cite a maintainer's discussion entry");
      if (choice.question !== null) throw new Error("a decided choice must not ask the question again");
      decision = { summary: text(judgment.summary, 1000),
        source: { kind: entry.kind, id: entry.id, by: entry.actor.login } };
    }
    return {
      change: text(choice.change, 1000), before: text(choice.before, 1000),
      after: text(choice.after, 1000), question: decision ? null : text(choice.question, 1000), decision,
      paths: choice.paths as string[],
    };
  });
  if ((input.status === "no-product-change") !== (decisions.length === 0)) throw new Error("product status contradicts its choices");
  return {
    base: manifest.base, head: manifest.head, status: input.status,
    summary: text(input.summary, 2000), decisions,
  };
}
