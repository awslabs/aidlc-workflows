import { readFileSync, writeFileSync } from "fs";
import { parseTestingContract, renderTestingContract, resolveTestingPosture } from "../../../.devin/tools/aidlc-testing-posture.ts";

const planPath = "aidlc/spaces/default/intents/260831-todo-api/construction/code-generation/code-generation-plan.md";
const plan = readFileSync(planPath, "utf-8");

const embedded = parseTestingContract(plan);
console.log("embedded:", embedded ? "found" : "null");

const current = resolveTestingPosture(process.cwd());
console.log("current contract_sha256:", current?.contract_sha256);

if (embedded) {
  console.log("embedded contract_sha256:", embedded.contract_sha256);
  console.log("match:", embedded.contract_sha256 === current?.contract_sha256);
}
