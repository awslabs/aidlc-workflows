import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createTestProject, seededRecordDir, cleanupTestProject } from "../harness/fixtures.ts";

let root: string, docs: string;
const { requirementAssignments } = await import("../../core/tools/aidlc-unit-requirements.ts");
const units = ["u-a", "u-b"];
const rows = [
  { id: "FR1.1", owner: "u-a", related: ["u-b"], required_for: "owner" },
  { id: "FR2.1", owner: "u-b", related: [], required_for: "owner" },
  { id: "FR9.1", owner: "u-b", related: [], required_for: "all" },
  { id: "NFR1", owner: "u-a", related: [], required_for: "all" },
];
function file(path: string, content: string) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); }
function setup() {
  root = createTestProject();
  docs = seededRecordDir(root);
  file(join(docs, "aidlc-state.md"), "# State\n");
  file(join(docs, "inception/units-generation/unit-of-work-dependency.md"), "```yaml\nunits:\n  - name: u-a\n    depends_on: []\n  - name: u-b\n    depends_on: []\n```\n");
  file(join(docs, "inception/requirements-analysis/requirements.md"), "FR1.1 FR2.1 FR9.1 NFR1");
  file(join(docs, "inception/units-generation/unit-of-work.md"), "| U1 | u-a |\n| U2 | u-b |");
  assignments(rows);
  file(join(root, "product.rs"), "test target");
}
function assignments(value: unknown) {
  file(join(docs, "inception/units-generation/unit-requirement-assignments.json"), JSON.stringify({version:1, assignments:value}));
}
function inspect(ids = ["FR1.1", "FR9.1", "NFR1"], unit = "u-a", tweak?: (v: {stage: string; unit: string; upstream_ids: string[]; coverage: {id: string; status: string; target: string}[]}) => void) {
  const path = join(docs, "construction", unit, "code-generation/traceability.json");
  const value = { stage:"code-generation", unit, upstream_ids:ids,
    coverage:ids.map(id=>({id,status:"OK",target:"product.rs"})) };
  tweak?.(value);
  file(path, JSON.stringify(value));
  const child = spawnSync(process.execPath, [join(import.meta.dir, "../../core/tools/aidlc-sensor-traceability.ts"), "--stage", "code-generation", "--output-path", path], { cwd: root, env: { ...process.env, AIDLC_PROJECT_DIR: root }, encoding: "utf8" });
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);

}
afterEach(() => { if(root) cleanupTestProject(root); });
test("independent assigned plus common succeeds; owner-related is not automatically required",()=>{setup();expect(inspect().pass).toBe(true);});
test("assigned deletion fails even downstream declares fewer IDs",()=>{setup();expect(inspect(["FR9.1","NFR1"]).missing_from_upstream_ids).toContain("FR1.1");});
test("common FR deletion fails",()=>{setup();expect(inspect(["FR1.1","NFR1"]).missing_from_upstream_ids).toContain("FR9.1");});
test("common NFR deletion fails",()=>{setup();expect(inspect(["FR1.1","FR9.1"]).missing_from_upstream_ids).toContain("NFR1");});
test("other Unit requirement excluded",()=>{setup();expect(inspect().missing_from_upstream_ids).not.toContain("FR2.1");});
test("participants explicitly require related Unit",()=>{setup();assignments(rows.map(x=>({...x,required_for:x.id==="FR1.1"?"participants":x.required_for})));expect(inspect(["FR2.1","FR9.1","NFR1"],"u-b").missing_from_upstream_ids).toContain("FR1.1");});
test("missing assignment input fails with reason",()=>{setup();rmSync(join(docs,"inception/units-generation/unit-requirement-assignments.json"));expect(inspect().reason).toContain("missing");});
test("malformed assignment input fails",()=>{setup();file(join(docs,"inception/units-generation/unit-requirement-assignments.json"),"{");expect(inspect().reason).toContain("malformed");});
test("missing NFR assignment fails rather than exclude",()=>{setup();assignments(rows.slice(0,3));expect(inspect().reason).toContain("missing assignment NFR1");});
test("duplicate conflicting assignment fails",()=>{setup();assignments([...rows,{...rows[0],owner:"u-b",related:[]}]);expect(inspect().reason).toContain("duplicate/conflicting");});
test("unknown Unit fails",()=>{setup();expect(inspect(undefined,"u-unknown").reason).toContain("not declared");});
test("unknown owner fails",()=>{setup();assignments(rows.map(x=>({...x,owner:"unknown"})));expect(inspect().reason).toContain("unknown owner");});
test("owner also related conflict fails",()=>{setup();assignments(rows.map(x=>({...x,related:[x.owner]})));expect(inspect().reason).toContain("invalid related");});
test("unresolved applicability fails",()=>{setup();assignments(rows.map(x=>({...x,required_for:"unresolved"})));expect(inspect().reason).toContain("unresolved");});
test("unknown requirement fails",()=>{setup();assignments([...rows,{...rows[0],id:"NFR99"}]);expect(inspect().reason).toContain("unknown requirement");});
test("stories AC route remains scoped, no assignment JSON needed",()=>{setup();rmSync(join(docs,"inception/units-generation/unit-requirement-assignments.json"));file(join(docs,"inception/user-stories/stories.md"),"US1.1 AC1.1.1 US2.1 AC2.1.1");file(join(docs,"inception/units-generation/unit-of-work-story-map.md"),"| US1.1 | u-a |\n| US2.1 | u-b |");expect(inspect(["AC1.1.1"]).pass).toBe(true);});
test("zero Unit retains global FR/NFR expectations",()=>{setup();rmSync(join(docs,"inception/units-generation/unit-of-work-dependency.md"));expect(inspect(["FR1.1","FR2.1","FR9.1","NFR1"],"").pass).toBe(true);expect(inspect(["FR1.1"],"").missing_from_upstream_ids).toContain("FR2.1");});
test("detailed NFR and BR are still required",()=>{setup();file(join(docs,"construction/u-a/nfr-requirements/security-requirements.md"),"NFR1.1");file(join(docs,"construction/u-a/functional-design/rules.md"),"BR1.1");const result=inspect();expect(result.missing_from_upstream_ids).toContain("NFR1.1");expect(result.missing_from_upstream_ids).toContain("BR1.1");expect(inspect(["FR1.1","FR9.1","NFR1","NFR1.1","BR1.1"]).pass).toBe(true);});
test("missing target rejected",()=>{setup();expect(inspect(undefined,undefined,v=>v.coverage[0].target="absent").invalid_targets.length).toBe(1);});
test("escaping path rejected",()=>{setup();expect(inspect(undefined,undefined,v=>v.coverage[0].target="../outside").invalid_targets.length).toBe(1);});
test("absolute target rejected",()=>{setup();expect(inspect(undefined,undefined,v=>v.coverage[0].target="/tmp/product").invalid_targets.length).toBe(1);});
test("unknown status rejected",()=>{setup();expect(inspect(undefined,undefined,v=>v.coverage[0].status="SKIP").invalid_entries.length).toBe(1);});
test("GAP and ORPHAN never pass",()=>{setup();for(const status of ["GAP","ORPHAN"])expect(inspect(undefined,undefined,v=>v.coverage[0].status=status).pass).toBe(false);});
test("unknown queried Unit pure resolver fails",()=>{expect(requirementAssignments(JSON.stringify({version:1,assignments:rows}),new Set(rows.map(x=>x.id)),units,"unknown").reasons.length).toBeGreaterThan(0);});
test("reviewable draft cannot be used as active assignment",()=>{expect(requirementAssignments(JSON.stringify({version:1,draft:true,assignments:rows}),new Set(rows.map(x=>x.id)),units,"u-a").reasons.join(" ")).toContain("draft input");});
test("wrong schema version fails",()=>{expect(requirementAssignments(JSON.stringify({version:2,assignments:rows}),new Set(rows.map(x=>x.id)),units,"u-a").reasons.join(" ")).toContain("version1");});
test("missing coverage row still fails",()=>{setup();expect(inspect(undefined,undefined,v=>v.coverage.pop()).missing_from_table).toContain("NFR1");});

test("new Units Generation validates all intent NFR assignments before handoff",()=>{
  setup();file(join(docs,"inception/units-generation/unit-of-work-story-map.md"),"| Requirement | Unit |\n|---|---|\n| FR1.1 | u-a |\n| FR2.1 | u-b |\n| FR9.1 | u-b |\n");
  const path=join(docs,"inception/units-generation/traceability.json");
  file(path,JSON.stringify({stage:"units-generation",upstream_ids:["FR1.1","FR2.1","FR9.1"],coverage:[{id:"FR1.1",status:"OK",target:"u-a"},{id:"FR2.1",status:"OK",target:"u-b"},{id:"FR9.1",status:"OK",target:"u-b"}]}));
  const run=()=>JSON.parse(spawnSync(process.execPath,[join(import.meta.dir,"../../core/tools/aidlc-sensor-traceability.ts"),"--stage","units-generation","--output-path",path],{cwd:root,env:{...process.env,AIDLC_PROJECT_DIR:root},encoding:"utf8"}).stdout);
  expect(run().pass).toBe(true);assignments(rows.slice(0,3));expect(run().reason).toContain("missing assignment NFR1");
});
test("a Unit with no upstream requirements retains the empty-scope failure",()=>{
  setup();assignments(rows.map(row=>({...row,owner:"u-b",related:[],required_for:"owner"})));expect(inspect([]).pass).toBe(false);
});
test("wrong related types, duplicate participants and null rows fail without throwing",()=>{
  for(const value of [null,{},[],{...rows[0],related:"u-b"},{...rows[0],related:["u-b","u-b"]}]) {
    expect(requirementAssignments(JSON.stringify({version:1,assignments:[value,...rows.slice(1)]}),new Set(rows.map(row=>row.id)),units,"u-a").reasons.length).toBeGreaterThan(0);
  }
});
