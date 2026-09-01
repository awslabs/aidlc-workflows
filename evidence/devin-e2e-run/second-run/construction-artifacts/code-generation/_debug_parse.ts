import { readFileSync } from "node:fs";

const planPath = process.argv[2];
const plan = readFileSync(planPath, "utf-8");
const lines = plan.split(/\r?\n/);
let found = false;
let inFence = false;
const body: string[] = [];
for (const line of lines) {
  if (/^```/.test(line)) {
    if (found) body.push(line);
    inFence = !inFence;
    continue;
  }
  if (!inFence && line.trimEnd() === "## Testing Contract") {
    found = true;
    continue;
  }
  if (found && !inFence && /^## [^\n]*$/.test(line)) break;
  if (found) body.push(line);
}
const section = found ? body.join("\n") : "";
const match = section.match(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/i);
console.log("found:", found);
console.log("section length:", section.length);
console.log("match:", match ? "yes" : "no");
if (match) {
  try {
    const parsed = JSON.parse(match[1]);
    console.log("parsed keys:", Object.keys(parsed));
    console.log("contract_sha256:", parsed.contract_sha256);
  } catch (e) {
    console.log("parse error:", (e as Error).message);
  }
} else {
  console.log("section first 200 chars:", section.slice(0, 200));
}
