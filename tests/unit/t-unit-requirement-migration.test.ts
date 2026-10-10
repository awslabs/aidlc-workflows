import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createTestProject, seededRecordDir, cleanupTestProject } from "../harness/fixtures.ts";
import { migrateProjectRequirementAssignments, recoverRequirementAssignments, loadRequirementAssignments } from "../../core/tools/aidlc-unit-requirements.ts";
import { executePlan, writeOperation } from "../../core/tools/aidlc-transaction.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const projects: string[] = [];
const units = ["u1-api", "u2-ui"];
const definition = "| Unit ID | Directory |\n|---|---|\n| U1 | u1-api |\n| U2 | u2-ui |\n";
const map = "| Requirement | Owner | Related | Required For |\n|---|---|---|---|\n| FR1 | U1 | U2 | participants |\n| FR2 | U2 | | owner |\n| NFR1 | U1 | U2 | all |\n";
const requirements = "FR1 FR2 NFR1";
function write(path: string, content: string) { mkdirSync(join(path, ".."), {recursive:true}); writeFileSync(path, content); }
function setup() {
  const root = createTestProject(); projects.push(root);
  const record = seededRecordDir(root);
  seed(record);
  return { root, record, dir:join(record,"inception/units-generation"), path:join(record,"inception/units-generation/unit-requirement-assignments.json") };
}
function seed(record: string) {
  write(join(record, "aidlc-state.md"), "# State\n");
  write(join(record, "inception/requirements-analysis/requirements.md"), requirements);
  write(join(record, "inception/units-generation/unit-of-work.md"), definition);
  write(join(record, "inception/units-generation/unit-of-work-story-map.md"), map);
  write(join(record, "inception/units-generation/unit-of-work-dependency.md"), "```yaml\nunits:\n  - name: u1-api\n    depends_on: []\n  - name: u2-ui\n    depends_on: []\n```\n");
}
afterEach(()=>{for(const root of projects.splice(0)) cleanupTestProject(root);});
test("complete explicit upstream recovery includes shared NFR and participants",()=>{
  const recovered=recoverRequirementAssignments(requirements,definition,map,units);
  expect(recovered.reasons).toEqual([]);
  expect(recovered.document?.assignments).toContainEqual({id:"NFR1",owner:"u1-api",related:["u2-ui"],required_for:"all"});
});
test("one implementing FR Unit is recoverable; optional legacy NFR scope is not guessed",()=>{
  const legacy="| Requirement | Unit ID | Directory |\n|---|---|---|\n| FR1 | U1 | u1-api |\n| FR2 | U2 | u2-ui |\n";
  expect(recoverRequirementAssignments("FR1 FR2",definition,legacy,units).document?.assignments).toHaveLength(2);
  expect(recoverRequirementAssignments(requirements,definition,legacy+"| NFR1 | U1 | u1-api |\n",units).document).toBeUndefined();
});
test("shared FR without explicit applicability is not narrowed",()=>{
  expect(recoverRequirementAssignments("FR1",definition,"| Requirement | Owner | Related |\n|---|---|---|\n| FR1 | U1 | U2 |\n",units).document).toBeUndefined();
  expect(recoverRequirementAssignments("FR1",definition,"| Requirement | Unit ID | Directory |\n|---|---|---|\n| FR1 | U1 | u1-api, u2-ui |\n",units).document).toBeUndefined();
});
test("duplicate/conflicting, unknown, incomplete and ambiguous rows do not yield a partial document",()=>{
  for(const text of [map+"| FR1 | U2 | | owner |\n",map.replace("| NFR1 | U1 | U2 | all |", ""),map.replace("U1 | U2 | all", "unknown | U2 | all"),map.replace("U1 | U2 | participants", "U1, U2 | | participants"),map+"| FR99 | U1 | | all |\n"]) {
    expect(recoverRequirementAssignments(requirements,definition,text,units).document).toBeUndefined();
  }
});
test("code-fenced/commented tables are not migration authority",()=>{
  expect(recoverRequirementAssignments(requirements,definition,"```md\n"+map+"```",units).document).toBeUndefined();
  expect(recoverRequirementAssignments(requirements,definition,"<!--\n"+map+"-->",units).document).toBeUndefined();
});
test("conflicting Unit aliases cannot select an owner",()=>{
  expect(recoverRequirementAssignments(requirements,definition+"| U1 | u2-ui |\n",map,units).document).toBeUndefined();
});
test("refresh migration is idempotent and preserves all source/state bytes",()=>{
  const {root,record,path,dir}=setup();
  const approval=join(record,"construction/u1-api/code-generation/.approval-fixture.json");write(approval,'{"decision":"approved","fingerprint":"existing"}');
  const approvalBytes=readFileSync(approval);
  const state=readFileSync(join(record,"aidlc-state.md")); const source=readFileSync(join(dir,"unit-of-work-story-map.md"));
  expect(migrateProjectRequirementAssignments(root).join(" ")).toContain("Recovered");
  const first=readFileSync(path);
  expect(migrateProjectRequirementAssignments(root)).toEqual([]);
  expect(readFileSync(approval)).toEqual(approvalBytes);expect(readFileSync(path)).toEqual(first); expect(readFileSync(join(record,"aidlc-state.md"))).toEqual(state); expect(readFileSync(join(dir,"unit-of-work-story-map.md"))).toEqual(source);
});
test("existing malformed/draft assignments are never overwritten",()=>{
  const {root,path}=setup();
  for(const text of ["{",'{"version":1,"draft":true,"assignments":[]}']) {
    write(path,text); expect(migrateProjectRequirementAssignments(root)).toEqual([]); expect(readFileSync(path,"utf8")).toBe(text);
  }
});
test("ambiguous input leaves no file and names missing NFR and repair location",()=>{
  const {root,path,dir}=setup(); write(join(dir,"unit-of-work-story-map.md"),map.replace("| NFR1 | U1 | U2 | all |", ""));
  const notes=migrateProjectRequirementAssignments(root).join(" ");
  expect(existsSync(path)).toBe(false);expect(notes).toContain("missing assignment NFR1");expect(notes).toContain("unit-requirement-assignments.json");
  write(join(dir,"unit-of-work-story-map.md"),map);migrateProjectRequirementAssignments(root);expect(existsSync(path)).toBe(true);
});
test("multiple intents/spaces are independently migrated without cursor switches",()=>{
  const {root,path}=setup(); const other=join(root,"aidlc/spaces/other/intents/other-record");seed(other);
  const cursor=join(root,"aidlc/spaces/default/active-intent");const before=existsSync(cursor)?readFileSync(cursor):null;
  const notes=migrateProjectRequirementAssignments(root);expect(notes.filter(note=>note.startsWith("Recovered"))).toHaveLength(2);
  expect(existsSync(path)).toBe(true);expect(existsSync(join(other,"inception/units-generation/unit-requirement-assignments.json"))).toBe(true);
  expect(existsSync(cursor)?readFileSync(cursor):null).toEqual(before);
});
test("stories, no DAG and malformed DAG leave assignments absent",()=>{
  for(const kind of ["stories","none","malformed"]) {
    const {root,path,dir,record}=setup();
    if(kind==="stories")write(join(record,"inception/user-stories/stories.md"),"US1.1 AC1.1.1");
    else if(kind==="none")rmSync(join(dir,"unit-of-work-dependency.md"));
    else write(join(dir,"unit-of-work-dependency.md"),"```yaml\nunits: invalid\n```");
    migrateProjectRequirementAssignments(root);expect(existsSync(path)).toBe(false);
  }
});
test("read-only fallback recovers explicit sources without writing and preserves invalid JSON precedence",()=>{
  const {dir,path}=setup();expect(loadRequirementAssignments(dir,requirements,units,"u2-ui").ids).toEqual(new Set(["FR1","FR2","NFR1"]));expect(existsSync(path)).toBe(false);
  write(path,"{");expect(loadRequirementAssignments(dir,requirements,units,"u2-ui").reasons.join(" ")).toContain("malformed");
});
test("failed absent-only transaction and interrupted commit preserve competing file and allow retry",()=>{
  const {root,path}=setup();const rel=path.slice(root.length+1);const plan={schemaVersion:1 as const,root,operations:[writeOperation(rel,"new", "absent")]};
  expect(()=>executePlan(plan,{failAfter:1})).toThrow();expect(existsSync(path)).toBe(false);
  write(path,"someone else's assignments");expect(()=>executePlan(plan)).toThrow();expect(readFileSync(path,"utf8")).toBe("someone else's assignments");
  rmSync(path);migrateProjectRequirementAssignments(root);expect(JSON.parse(readFileSync(path,"utf8")).version).toBe(1);
  expect(readdirSync(root).filter(name=>name.startsWith(".aidlc-txn-"))).toEqual([]);
});
test("existing symlink assignment target is preserved",()=>{
  const {root,path}=setup();const outside=join(root,"outside.json");write(outside,"keep");symlinkSync(outside,path);
  expect(migrateProjectRequirementAssignments(root)).toEqual([]);expect(readFileSync(outside,"utf8")).toBe("keep");
});

test("concurrent migrations publish one complete file and converge",async()=>{
  const {root,path}=setup();
  const source=join(import.meta.dir,"../../core/tools/aidlc-unit-requirements.ts");
  const code=`import { migrateProjectRequirementAssignments } from ${JSON.stringify(source)}; console.log(JSON.stringify(migrateProjectRequirementAssignments(process.env.MIGRATION_PROJECT!)));`;
  const children=[0,1].map(()=>Bun.spawn([process.execPath,"-e",code],{env:{...process.env,MIGRATION_PROJECT:root},stdout:"pipe",stderr:"pipe"}));
  const results=await Promise.all(children.map(async child=>({status:await child.exited,out:await new Response(child.stdout).text(),err:await new Response(child.stderr).text()})));
  expect(results.map(result=>result.status)).toEqual([0,0]);expect(results.map(result=>result.out).join(" ").match(/Recovered/g)).toHaveLength(1);
  expect(JSON.parse(readFileSync(path,"utf8")).assignments).toHaveLength(3);
});
test("actual config refresh persists recoverable assignments; dry-run preserves them absent",()=>{
  const {root,path}=setup();
  const script=join(import.meta.dir,"../../core/tools/aidlc-init.ts");
  const release=join(import.meta.dir,"../../dist-release/codex");
  const run=(extra:string[])=>spawnSync(process.execPath,[script,"config","--project-dir",root,"--from",release,"--harness","codex","--mcp","none","--yes",...extra],{cwd:root,env:{...process.env,AIDLC_INSTALL_ROOT:join(root,"machine/share"),AIDLC_BIN_DIR:join(root,"machine/bin")},encoding:"utf8",timeout:remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)});
  const installed=run([]);expect(installed.status,installed.stdout+installed.stderr).toBe(0);
  // A fresh harness addition is not a refresh. A repeated config owns migration.
  if(existsSync(path))rmSync(path);
  const dry=run(["--dry-run"]);expect(dry.status,dry.stdout+dry.stderr).toBe(0);expect(existsSync(path)).toBe(false);
  const refreshed=run([]);expect(refreshed.status,refreshed.stdout+refreshed.stderr).toBe(0);expect(existsSync(path)).toBe(true);
});

test("alternate related column, contradictory owner columns and unknown applicability columns fail closed",()=>{
  for(const text of [
    "| FR | Unit | Related Units |\n|---|---|---|\n| FR1 | U1 | U2 |\n",
    "| FR | Unit | Owner | Required For |\n|---|---|---|---|\n| FR1 | U1 | U2 | owner |\n",
    "| FR | Unit | Applicability |\n|---|---|---|\n| FR1 | U1 | all |\n",
    "| FR | Unit | Directory | Required For |\n|---|---|---|---|\n| FR1 | U1 | u2-ui | owner |\n"
  ])expect(recoverRequirementAssignments("FR1",definition,text,units).document).toBeUndefined();
});

test("symlinked migration directory cannot publish outside the project",()=>{
  const {root,dir}=setup();const external=createTestProject();projects.push(external);const other=seededRecordDir(external);seed(other);
  const externalDir=join(other,"inception/units-generation");const externalTarget=join(externalDir,"unit-requirement-assignments.json");
  rmSync(dir,{recursive:true});symlinkSync(externalDir,dir);
  const notes=migrateProjectRequirementAssignments(root).join(" ");
  expect(existsSync(externalTarget)).toBe(false);expect(notes).toContain("migration left existing files intact");
});
