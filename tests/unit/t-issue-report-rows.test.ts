// lib-rows.ts: every audit field by its own rule. A value AI-DLC's word list happens to hold (`billing`, `feature`)
// is kept only where its field holds nothing but AI-DLC's words; a name the person chose and text anyone wrote become
// labels; the check (valueOk) refuses every raw value and passes what the rule wrote.

import { describe, expect, test } from "bun:test";
import { fieldName, fieldNameOk, type RowVocab, type Shape, shapeValue, valueOk } from "../../core/skills/aidlc-issue-report/scripts/lib-rows.ts";

// AI-DLC's words, with the ordinary words a real install's list holds (measured: feature, billing, table, user).
function vocab(): RowVocab {
  return {
    words: new Set([
      "STAGE_STARTED", "ERROR_LOGGED", "HUMAN_TURN", "typed", "person", "approved", "in-progress", "workspace scan",
      "Nothing to add", "Request Changes", "Construction Unit Approval", "requirements.md", "org.md", "Unknown",
      "TypeScript", "guide", "engine", "log", "review", "stage", "unit", "reviewer", "Person Reply",
      "feature", "billing", "table", "user", "product", "api", "Way of Working",
    ]),
    stages: new Set(["requirements-analysis", "code-generation", "contract-design", "functional-design"]),
    phases: new Set(["inception", "construction", "initialization"]),
    agents: new Set(["aidlc-architecture-reviewer-agent", "aidlc-developer-agent"]),
    scopes: new Set(["classic", "feature"]),
    sensors: new Set(["required-sections", "traceability"]),
    hooks: new Set(["review-freeze", "plan-approval-guard"]),
    tools: new Set(["aidlc-log", "aidlc-state", "aidlc-log.ts"]),
    guards: new Set(["review-freeze"]),
    phrases: new Set(['Cannot start review for "', '": a required output document is missing', 'Refusing to complete unit "']),
  };
}
function shape(): Shape & { map: Map<string, string> } {
  const byKind = new Map<string, Map<string, string>>();
  const map = new Map<string, string>();
  return {
    map,
    label(kind, raw) {
      const m = byKind.get(kind) ?? new Map<string, string>();
      byKind.set(kind, m);
      if (!m.has(raw)) m.set(raw, `<custom-${kind}-${m.size + 1}>`);
      const l = m.get(raw) as string;
      map.set(raw, l);
      return l;
    },
    known: () => undefined,
  };
}
const flat = (x: unknown) => (Array.isArray(x) ? x.join(" ") : String(x));

describe("a value AI-DLC's word list holds is kept only where its field holds AI-DLC's words", () => {
  test("a Unit, a reply, an option or a file spelled like one of them is a label", () => {
    const v = vocab();
    const s = shape();
    expect(shapeValue(v, s, "UNIT_STARTED", "Unit", "billing")).toBe("<custom-unit-1>");
    expect(shapeValue(v, s, "HUMAN_TURN", "Person Reply", "feature")).toBe("<custom-text-1>");
    expect(shapeValue(v, s, "QUESTION_ASKED", "Options", "billing,Request Changes")).toEqual(["<custom-text-2>", "Request Changes"]);
    expect(shapeValue(v, s, "ARTIFACT_UPDATED", "File", "src/billing/user.ts")).toBe("<custom-file-1>.ts");
    expect(shapeValue(v, s, "ARTIFACT_UPDATED", "Context", "construction > billing > code-generation > plan.md")).toBe(
      "construction > <custom-unit-1> > code-generation > <custom-file-2>.md",
    );
  });
  test("a stage, an agent, a scope and an event stay", () => {
    const v = vocab();
    const s = shape();
    expect(shapeValue(v, s, "STAGE_STARTED", "Stage", "code-generation")).toBe("code-generation");
    expect(shapeValue(v, s, "REVIEW_REQUESTED", "Reviewer", "aidlc-architecture-reviewer-agent")).toBe("aidlc-architecture-reviewer-agent");
    expect(shapeValue(v, s, "WORKFLOW_STARTED", "Scope", "feature")).toBe("feature");
    expect(shapeValue(v, s, "HUMAN_TURN", "Source", "typed")).toBe("typed");
  });
});

describe("AI-DLC's own sentences keep their fixed text and label what was filled in", () => {
  test("an error: the phrase stays, the Unit in it is a label", () => {
    const v = vocab();
    const s = shape();
    const out = shapeValue(v, s, "ERROR_LOGGED", "Error", 'Refusing to complete unit "u2-cart-order"');
    expect(out).toBe('Refusing to complete unit "<custom-value-1>"');
    expect(valueOk(v, "ERROR_LOGGED", "Error", out)).toBe(true);
    expect(shapeValue(v, s, "ERROR_LOGGED", "Error", 'Cannot start review for "contract-design": a required output document is missing')).toBe(
      'Cannot start review for "contract-design": a required output document is missing',
    );
  });
  test("text that does not start with AI-DLC's fixed text is one label", () => {
    const v = vocab();
    const s = shape();
    expect(shapeValue(v, s, "ERROR_LOGGED", "Error", "the billing service for Contoso broke; Cannot start review for \"x\"")).toBe("<custom-text-1>");
  });
  test("a command of AI-DLC's tools keeps its words and labels a Unit; any other command is one label", () => {
    const v = vocab();
    const s = shape();
    const out = shapeValue(v, s, "ERROR_LOGGED", "Command", "aidlc-log engine log review --stage code-generation --unit u1-single-order");
    expect(out).toBe("aidlc-log engine log review --stage code-generation --unit <custom-unit-1>");
    expect(valueOk(v, "ERROR_LOGGED", "Command", out)).toBe(true);
    expect(shapeValue(v, s, "ERROR_LOGGED", "Command", "npm run deploy-billing")).toBe("<custom-text-1>");
  });
});

describe("what the rule wrote reads back as it was", () => {
  test("a one-word path, an unknown flag and a sentence after a short piece read back unchanged", () => {
    const v = vocab();
    const s = shape();
    const cases: [string, string, string][] = [
      ["ARTIFACT_UPDATED", "Path", "aidlc"],
      ["ARTIFACT_UPDATED", "Destination", ".claude"],
      ["ERROR_LOGGED", "Command", "aidlc-log engine next --foo=bar"],
      ["ERROR_LOGGED", "Command", "aidlc-log engine next --foo bar"],
      ["ERROR_LOGGED", "Error", 'x Refusing to complete unit "u2-cart-order"'],
      ["ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/i/construction/payments"],
    ];
    for (const [event, name, raw] of cases) {
      const out = shapeValue(v, s, event, name, raw);
      expect([raw, out, valueOk(v, event, name, out)]).toEqual([raw, out, true]);
    }
  });
  test("a label the redaction wrote over a kept value passes", () => {
    const v = vocab();
    expect(valueOk(v, "ERROR_LOGGED", "Command", "aidlc-log engine log review --stage <user>")).toBe(true);
    expect(valueOk(v, "STAGE_STARTED", "Status", "<repo>")).toBe(true);
    expect(valueOk(v, "ARTIFACT_UPDATED", "File", "aidlc/spaces/<user>/intents/<custom-intent-1>/notes.md")).toBe(false);
  });
  test("a label is small: a serial of four digits (six for this skill's own), an id of doctor's eight hex digits", async () => {
    const { smallLabel } = await import("../../core/skills/aidlc-issue-report/scripts/redact.ts");
    for (const [label, small] of [
      ["<customer-1234>", true], ["<customer-12345>", false], ["<custom-id-123456>", true], ["<custom-id-1234567>", false],
      ["<id:a1b2c3d4>", true], ["<id:30481f2c>", true], ["<id:12345678>", true], ["<id:a1b2c3d>", false], ["<id:0123456789abcdef>", false], ["<id:123456789012>", false],
      ["<user>", true], ["<project>", true],
    ] as const) {
      expect([label, smallLabel(label)]).toEqual([label, small]);
    }
  });
  test("a control character, a long id label and an id label inside AI-DLC's sentence are read as they are", () => {
    const v = vocab();
    expect(valueOk(v, "HUMAN_TURN", "Person Reply", "\u0000")).toBe(false);
    expect(valueOk(v, "HUMAN_TURN", "Person Reply", `<id:${"436f6e746f736f".repeat(3)}>`)).toBe(false);
    expect(valueOk(v, "HUMAN_TURN", "Person Reply", "<id:a1b2c3d4>")).toBe(true);
    expect(valueOk(v, "ERROR_LOGGED", "Error", 'Refusing to complete unit "<id:a1b2c3d4>"')).toBe(true);
  });
  test("a long number filled into AI-DLC's sentence is a label; a short one stays", () => {
    const v = vocab();
    const s = shape();
    expect(shapeValue(v, s, "ERROR_LOGGED", "Error", 'Refusing to complete unit "481516"')).toBe('Refusing to complete unit "<custom-value-1>"');
    expect(shapeValue(v, s, "ERROR_LOGGED", "Error", 'Refusing to complete unit "12"')).toBe('Refusing to complete unit "12"');
    expect(valueOk(v, "ERROR_LOGGED", "Error", 'Refusing to complete unit "481516"')).toBe(false);
  });
  test("a well-known file with no dot in AI-DLC's path is a file, not a folder", () => {
    const v = vocab();
    const s = shape();
    const out = String(shapeValue(v, s, "ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/i/construction/u1/Makefile"));
    expect(out.split("/").pop()).toMatch(/^<custom-file-\d+>$/);
    expect(valueOk(v, "ARTIFACT_UPDATED", "File", out)).toBe(true);
  });
  test("a well-known file name is read in any case at the end, and a folder of that name in the middle is a folder", () => {
    const v = vocab();
    const s = shape();
    expect(String(shapeValue(v, s, "ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/i/construction/u1/makefile")).split("/").pop()).toMatch(/^<custom-file-\d+>$/);
    expect(String(shapeValue(v, s, "ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/i/construction/VERSION/notes.md")).split("/").at(-2)).toMatch(/^<custom-dir-\d+>$/);
  });
  test("two files of one name in two folders are two files", () => {
    const v = vocab();
    const s = shape();
    const a = shapeValue(v, s, "ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/i/construction/u1/notes.md");
    const b = shapeValue(v, s, "ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/i/construction/u2/notes.md");
    expect(String(a).split("/").pop()).not.toBe(String(b).split("/").pop());
  });
  test("a Unit's name in AI-DLC's path is the Unit's label wherever it stands; another name is a folder before the end and a file at it", () => {
    const v = vocab();
    const s = { ...shape(), known: (raw: string) => (raw === "billing" ? "<unit-1>" : undefined) };
    const end = shapeValue(v, s, "ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/i/construction/billing");
    const middle = shapeValue(v, s, "ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/i/construction/billing/plan.md");
    expect(String(end).endsWith("/construction/<unit-1>")).toBe(true);
    expect(String(middle)).toMatch(/\/construction\/<unit-1>\/<custom-file-\d+>\.md$/);
    const t = shape();
    expect(shapeValue(v, t, "ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/i/construction/notes")).toBe(
      "aidlc/spaces/default/intents/<custom-intent-1>/construction/<custom-file-1>",
    );
    expect(shapeValue(v, t, "ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/i/construction/notes/plan.md")).toBe(
      "aidlc/spaces/default/intents/<custom-intent-1>/construction/<custom-dir-1>/<custom-file-2>.md",
    );
    expect(shapeValue(v, t, "ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/i/inception/requirements-analysis/requirements.md")).toBe(
      "aidlc/spaces/default/intents/<custom-intent-1>/inception/requirements-analysis/requirements.md",
    );
  });

});

describe("a gate's check states", () => {
  test("each entry keeps its check, its result and AI-DLC's layout; a value of another shape is one label", () => {
    const v = vocab();
    const s = shape();
    const raw = "required-sections@aidlc/spaces/default/intents/261022-x/inception/requirements-analysis/requirements.md=passed; traceability@aidlc/spaces/default/intents/261022-x/construction/u1/plan.md=failed(2) [detail: aidlc/spaces/default/intents/261022-x/.aidlc-engine/sensors/code-generation/required-sections-1a2b3c4d.md]; +3 more";
    const out = String(shapeValue(v, s, "STAGE_AWAITING_APPROVAL", "Sensor State", raw));
    expect(out.split("; ").map((e) => e.replace(/@.*=/, "@=").replace(/ \[detail: .*\]/, " [detail]"))).toEqual(["required-sections@=passed", "traceability@=failed(2) [detail]", "+3 more"]);
    expect(out).not.toContain("261022-x");
    expect(valueOk(v, "STAGE_AWAITING_APPROVAL", "Sensor State", out)).toBe(true);
    expect(shapeValue(v, s, "STAGE_AWAITING_APPROVAL", "Sensor State", "none")).toBe("none");
    const plugin = String(shapeValue(v, s, "STAGE_AWAITING_APPROVAL", "Sensor State", "plugin-check@aidlc/spaces/default/intents/x/construction/u1/plan.md=passed"));
    expect([plugin.startsWith("<custom-value-"), valueOk(v, "STAGE_AWAITING_APPROVAL", "Sensor State", plugin)]).toEqual([true, true]);
    expect(shapeValue(v, s, "STAGE_AWAITING_APPROVAL", "Sensor State", "required-sections looked fine to Kim")).toMatch(/^<custom-text-\d+>$/);
  });
});

describe("paths", () => {
  test("AI-DLC's layout stays, the person's names in it are labels", () => {
    const v = vocab();
    const s = shape();
    expect(shapeValue(v, s, "ARTIFACT_CREATED", "File", "aidlc/spaces/default/intents/261022-table-order/inception/requirements-analysis/requirements.md")).toBe(
      "aidlc/spaces/default/intents/<custom-intent-1>/inception/requirements-analysis/requirements.md",
    );
    expect(shapeValue(v, s, "ARTIFACT_CREATED", "File", "aidlc/spaces/acme-team/intents/x/construction/u1/notes.md")).toBe(
      "aidlc/spaces/<custom-space-1>/intents/<custom-intent-2>/construction/<custom-dir-1>/<custom-file-1>.md",
    );
    expect(shapeValue(v, s, "REVIEW_COMPLETED", "Review File", ".aidlc-engine/reviews/code-generation/stage/aac1a74fe7dc7bbc/1.e9adff770ddb3ca88e6a635ed47dfdb9.review.md")).toBe(
      ".aidlc-engine/reviews/code-generation/stage/<custom-hash-1>/1.<custom-hash-2>.review.md",
    );
  });
  test("an absolute path, a home path, a path that climbs out and a made-up extension name nothing", () => {
    const v = vocab();
    const s = shape();
    for (const p of ["/Users/kim/acme/src/a.ts", "C:/Users/kim/a.ts", "~/acme/a.ts", "../acme/a.ts", "https://acme.example/a.ts"]) {
      expect(shapeValue(v, s, "ARTIFACT_UPDATED", "File", p)).toMatch(/^<custom-file-\d+>$/);
    }
    expect(shapeValue(v, s, "ARTIFACT_UPDATED", "File", "docs/plan.contoso")).toMatch(/^<custom-file-\d+>$/);
  });
});

describe("the check refuses a raw value in every kind of field", () => {
  const raw: [string, string, unknown][] = [
    ["STAGE_STARTED", "Stage", "billing-rollout"],
    ["UNIT_STARTED", "Unit", "u1-single-order"],
    ["UNIT_STARTED", "Unit", "billing"],
    ["HUMAN_TURN", "Person Reply", "feature"],
    ["ARTIFACT_UPDATED", "File", "src/billing/user.ts"],
    ["ARTIFACT_UPDATED", "File", "aidlc/spaces/default/intents/261022-table-order/x.md"],
    ["ARTIFACT_UPDATED", "Context", "construction > u1-single-order > code-generation > plan.md"],
    ["ERROR_LOGGED", "Command", "npm run deploy-billing"],
    ["ERROR_LOGGED", "Command", "aidlc-log engine log review --unit u1-single-order"],
    ["ERROR_LOGGED", "Error", 'Refusing to complete unit "u2-cart-order"'],
    ["ERROR_LOGGED", "Exit Code", "123456"],
    ["ERROR_LOGGED", "Exit Code", 1234567890],
    ["REVIEW_COMPLETED", "Artifact Fingerprint", "sha256:1d1c41ec"],
    ["HUMAN_TURN", "Session", "6f1c2b9e-1111-2222-3333-444455556666"],
    ["X", "<contoso>", "<custom-value-1>"],
    ["X", "Unit", "<contoso>"],
    ["X", "Unit", "<custom-contoso-1>"],
    ["X", "Unit", "<custom-unit-1234567>"],
    ["QUESTION_ASKED", "Options", ["billing"]],
    ["X", "Some Field", "Acme Corp"],
  ];
  for (const [event, name, value] of raw) {
    test(`${name}: ${JSON.stringify(value)}`, () => {
      const v = vocab();
      expect(fieldNameOk(v, name) && valueOk(v, event, name, value)).toBe(false);
    });
  }
});

// Producer and check agree, and nothing planted gets through: rows made of AI-DLC's words, ordinary words the list
// holds and planted names, through the rule, always pass the check and never carry a planted name.
describe("what the rule writes always passes the check, and carries no planted name", () => {
  const NAMES = ["Unit", "Stage", "Person Reply", "File", "Context", "Error", "Command", "Options", "Details", "Status", "Exit Code", "Source", "Target", "Session", "Mystery Field", "Changed", "Sensor State"];
  const PLANTED = ["ContosoPay", "zorbleq", "acme-ledger", "kimjiwoo", "Project Falcon", "481516"];
  const PIECES = [...PLANTED, "billing", "feature", "code-generation", "construction", "typed", "src/", "aidlc/spaces/default/intents/", "Refusing to complete unit \"", "\"", " > ", ", ", ".ts", "--unit ", "aidlc-log engine log review ", "Q1: A", "aidlc", ".claude", "--foo=", "x ", "<repo>", "<user>", " (and 3 more)", "required-sections@", "=passed", "; ", "=failed(2) [detail: ", "]"];
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  test("4,000 seeded fields from each of three seeds", () => {
    const v = vocab();
    for (let i = 0; i < 12000; i++) {
      if (i % 4000 === 0) seed = [7, 11, 13][i / 4000];
      const s = shape();
      const name = NAMES[rnd(NAMES.length)];
      const raw = Array.from({ length: 1 + rnd(5) }, () => PIECES[rnd(PIECES.length)]).join("");
      const event = rnd(2) ? "ERROR_LOGGED" : "STAGE_JUMPED";
      const out = shapeValue(v, s, event, name, raw);
      const shownName = fieldName(v, s, name);
      expect([name, raw, out, valueOk(v, event, shownName, out)]).toEqual([name, raw, out, true]);
      // A number field keeps AI-DLC's own number (an exit code, a duration), so a planted number may stay there.
      for (const p of PLANTED) if (!(name === "Exit Code" && typeof out === "number")) expect([raw, flat(out).includes(p)]).toEqual([raw, false]);
      // A raw value the check passes as it stands carries no planted name either.
      if (valueOk(v, event, shownName, raw)) for (const p of PLANTED) expect([raw, raw.includes(p)]).toEqual([raw, false]);
    }
  });
});
