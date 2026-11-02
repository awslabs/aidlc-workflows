import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHome } from "../../core/command-center/server/model/home";
import { listIntents } from "../../core/command-center/server/parse/registry";
import { readAuditDir } from "../../core/command-center/server/parse/audit";
import { readReviewRecords } from "../../core/command-center/server/parse/reviews";
import { loadCatalog } from "../../core/command-center/server/parse/stage-graph";
import { AUDIT_HEADER, block, makeWorkspace, STATE_MD } from "./fixtures/make";

const SECRET = "OUTSIDE-SECRET";
const found = (ws: string) => [{ path: ws, origin: "pin" as const, root: null, exists: true }];

/** A workspace whose registry, record files and audit shards all try to reach data outside `<ws>/aidlc`. */
async function hostile() {
  const ws = await makeWorkspace();
  const out = await mkdtemp(join(tmpdir(), "cc-outside-"));
  const idir = join(ws, "aidlc/spaces/default/intents"); const rec = join(idir, "260811-demo");
  // Outside data, every piece tagged with SECRET.
  await writeFile(join(out, "state.md"), STATE_MD.replace("Synthetic demo", SECRET));
  await writeFile(join(out, "leak.md"), AUDIT_HEADER + block("2026-08-14T00:00:00Z", "GATE_APPROVED", { Stage: SECRET, Details: SECRET }));
  await writeFile(join(out, "directive.json"), JSON.stringify({ stage: SECRET, unit: SECRET, kind: "ask" }));
  await writeFile(join(out, "uow.md"), `| Unit ID |\n|---|\n| ${SECRET} |\n| b |\n| c |\n`);
  await mkdir(join(out, "rec"), { recursive: true });
  await writeFile(join(out, "rec/aidlc-state.md"), STATE_MD.replace("Synthetic demo", SECRET));
  // `../../../etc-ish` from the intents dir lands in the workspace root, outside aidlc/.
  await mkdir(join(ws, "etc-ish"), { recursive: true });
  await writeFile(join(ws, "etc-ish/aidlc-state.md"), STATE_MD.replace("Synthetic demo", SECRET));
  const reg = JSON.parse(await readFile(join(idir, "intents.json"), "utf8"));
  await writeFile(join(idir, "intents.json"), JSON.stringify([...reg,
    { uuid: "u-x", slug: "escape", dirName: "../../../etc-ish" },
    { uuid: "u-y", slug: "back", dirName: "a\\..\\..\\b" },
    { uuid: "u-z12345678", slug: "../../../etc-ish" },
    { uuid: "u-s", slug: "linked", dirName: "linked" },
  ]));
  // A registered record dir that is a symlink to outside.
  await symlink(join(out, "rec"), join(idir, "linked"));
  // An unregistered symlinked record dir.
  await symlink(join(out, "rec"), join(idir, "zz-unregistered"));
  // Record files of the real intent symlinked outside.
  await rm(join(rec, "aidlc-state.md")); await symlink(join(out, "state.md"), join(rec, "aidlc-state.md"));
  await rm(join(rec, ".aidlc-active-directive.json")); await symlink(join(out, "directive.json"), join(rec, ".aidlc-active-directive.json"));
  await mkdir(join(rec, ".aidlc-engine"), { recursive: true }); await symlink(join(out, "directive.json"), join(rec, ".aidlc-engine/active-directive.json"));
  await mkdir(join(rec, "inception/units-generation"), { recursive: true }); await symlink(join(out, "uow.md"), join(rec, "inception/units-generation/unit-of-work.md"));
  await symlink(join(out, "leak.md"), join(rec, "audit/zz-leak.md"));
  return { ws, out, rec };
}

test("registry: traversal dirNames/slugs and symlinked record dirs are not listed", async () => {
  const { ws } = await hostile();
  const dirs = (await listIntents(ws)).map((r) => r.dir);
  expect(dirs).toContain("260811-demo");
  expect(dirs).toContain("linked"); // a valid name; buildIntent refuses its escaping realpath
  expect(dirs.some((d) => d.includes("..") || d.includes("/") || d.includes("\\"))).toBe(false);
  expect(dirs).not.toContain("zz-unregistered");
});

test("readAuditDir skips a shard symlinked outside the containment root", async () => {
  const { ws, rec } = await hostile();
  const r = await readAuditDir(join(rec, "audit"), join(ws, "aidlc"));
  expect(JSON.stringify(r)).not.toContain(SECRET);
  expect(r.events.length).toBeGreaterThan(0);
});

test("home payload carries no outside data; the escaping intent is partial and the symlinked state is noted", async () => {
  const { ws } = await hostile();
  const home = await buildHome(found(ws), new Date("2026-08-14T00:00:00Z"));
  expect(JSON.stringify(home)).not.toContain(SECRET);
  const w = home.workspaces[0]!;
  expect(w.status).toBe("partial");
  expect(w.intents.map((i) => i.dir)).toEqual(["260811-demo"]);
  const demo = w.intents[0]!;
  expect(demo.notes.some((n) => /aidlc-state\.md/.test(n))).toBe(true);
  expect(demo.title).toBeNull();
  expect(demo.unitsPlanned).not.toBe(3);
});

test("review records: a symlinked record file is not read; stage graph symlinked outside the workspace is ignored", async () => {
  const { ws, out, rec } = await hostile();
  await writeFile(join(out, "r.json"), JSON.stringify({ stage: SECRET, verdict: "READY", findings: [{ finding: SECRET }] }));
  await mkdir(join(rec, ".aidlc-engine/reviews"), { recursive: true });
  await symlink(join(out, "r.json"), join(rec, ".aidlc-engine/reviews/r.json"));
  expect(JSON.stringify(await readReviewRecords(rec))).not.toContain(SECRET);
  await writeFile(join(out, "graph.json"), JSON.stringify([{ slug: SECRET, phase: "ideation" }]));
  await rm(join(ws, ".claude/tools/data/stage-graph.json")); await symlink(join(out, "graph.json"), join(ws, ".claude/tools/data/stage-graph.json"));
  expect(JSON.stringify(await loadCatalog(ws))).not.toContain(SECRET);
});
