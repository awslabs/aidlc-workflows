#!/usr/bin/env node
/**
 * build/kiro-ide/build.js — Build the Kiro IDE distribution.
 *
 * Transforms:
 *   src/personas/*.yaml      → dist/kiro-ide/.kiro/agents/*.json
 *   src/skills/              → dist/kiro-ide/.kiro/skills/        (copy)
 *   src/stages/              → dist/kiro-ide/.kiro/stages/        (copy)
 *   src/conventions/         → dist/kiro-ide/.kiro/conventions/   (copy)
 *   src/tools/               → dist/kiro-ide/.kiro/tools/         (copy)
 *   src/kiro-ide/hooks/      → dist/kiro-ide/.kiro/hooks/         (copy)
 *
 * Usage: node build/kiro-ide/build.js
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "dist", "kiro-ide", ".kiro");

// --- Helpers ---

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cpR(src, dest) {
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true });
  }
}

function parseYaml(content) {
  // Simple YAML parser for our flat key-value persona files.
  // Handles: scalar strings, block scalars (| and >), and arrays (- item).
  const result = {};
  const lines = content.split("\n");
  let currentKey = null;
  let currentValue = "";
  let blockMode = null; // '|' or '>'

  function flush() {
    if (currentKey) {
      if (Array.isArray(result[currentKey])) {
        // already set as array
      } else {
        result[currentKey] = currentValue.trim();
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Top-level key detection (no leading whitespace, ends with :)
    const keyMatch = line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/);
    if (keyMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      currentKey = keyMatch[1];
      const valueAfterColon = keyMatch[2].trim();

      if (valueAfterColon === "|" || valueAfterColon === ">") {
        blockMode = valueAfterColon;
        currentValue = "";
      } else if (valueAfterColon === "" || valueAfterColon === "[]") {
        // Could be array or empty
        if (valueAfterColon === "[]") {
          result[currentKey] = [];
          currentKey = null;
        } else {
          // Peek ahead to see if next lines are array items
          if (i + 1 < lines.length && lines[i + 1].match(/^\s+-\s/)) {
            result[currentKey] = [];
            blockMode = "array";
            currentValue = "";
          } else {
            blockMode = null;
            currentValue = "";
          }
        }
      } else {
        blockMode = null;
        currentValue = valueAfterColon;
      }
      continue;
    }

    // Array item
    if (blockMode === "array" && line.match(/^\s+-\s/)) {
      const item = line.replace(/^\s+-\s*/, "").trim();
      result[currentKey].push(item);
      continue;
    }

    // Block scalar continuation
    if (blockMode === "|" || blockMode === ">") {
      if (line.match(/^\s/) || line === "") {
        currentValue += (blockMode === ">" && currentValue && line.trim() ? " " : "") +
          (blockMode === "|" ? line.replace(/^ {2}/, "") + "\n" : line.trim()) +
          (blockMode === ">" && line === "" ? "\n" : "");
      } else {
        // End of block — reprocess this line
        flush();
        blockMode = null;
        i--;
      }
      continue;
    }
  }
  flush();
  return result;
}

function personaToAgent(yamlContent) {
  const persona = parseYaml(yamlContent);

  // Build resources array from associated-skills + common skills (needed before prompt augment)
  const resources = [];

  // Add common skills (work-method, etc.)
  const commonSkillsDir = path.join(SRC, "skills", "common");
  if (fs.existsSync(commonSkillsDir)) {
    for (const skillDir of fs.readdirSync(commonSkillsDir, { withFileTypes: true })) {
      if (!skillDir.isDirectory()) continue;
      resources.push(`skill://.kiro/skills/common/${skillDir.name}/SKILL.md`);
    }
  }

  // Add domain skills from associated-skills
  const associatedSkills = persona["associated-skills"] || [];
  for (const skill of associatedSkills) {
    resources.push(`skill://.kiro/skills/${skill}/SKILL.md`);
  }

  // Build prompt from only identity fields (not metadata)
  const promptLines = [];
  promptLines.push(`name: ${persona.name || ""}`);
  promptLines.push("");
  if (persona.description) {
    promptLines.push(`description: >`);
    promptLines.push(`  ${persona.description.trim()}`);
    promptLines.push("");
  }
  if (persona.behaviour) {
    promptLines.push(`behaviour: |`);
    for (const line of persona.behaviour.trim().split("\n")) {
      promptLines.push(`  ${line}`);
    }
    promptLines.push("");
  }

  // Append target-specific prompt augment if it exists
  const augmentFile = path.join(SRC, "target-config", "kiro-ide", "persona-prompt-augment.yaml");
  if (fs.existsSync(augmentFile)) {
    const augmentContent = fs.readFileSync(augmentFile, "utf-8");
    const augment = parseYaml(augmentContent);
    if (augment["pre-augment"]) {
      promptLines.unshift(augment["pre-augment"].trim(), "");
    }
    if (augment["post-augment"]) {
      // Append the augment text followed by explicit skill paths
      let skillList = resources.map(r => r.replace("skill://", "")).join(", ");
      promptLines.push(augment["post-augment"].trim() + " " + skillList);
      promptLines.push("");
    }
  }

  const prompt = promptLines.join("\n");

  return {
    name: persona.name || "",
    description: (persona.description || "").trim(),
    prompt,
    tools: ["read", "write", "shell"],
    resources,
  };
}

// --- Main ---

console.log("Building dist/kiro-ide/ ...");

// Clean
rmrf(path.join(ROOT, "dist", "kiro-ide"));
fs.mkdirSync(OUT, { recursive: true });

// 1. Convert personas to agents
const agentsDir = path.join(OUT, "agents");
fs.mkdirSync(agentsDir, { recursive: true });

const personasDir = path.join(SRC, "personas");
if (fs.existsSync(personasDir)) {
  for (const file of fs.readdirSync(personasDir)) {
    if (!file.endsWith(".yaml")) continue;
    const content = fs.readFileSync(path.join(personasDir, file), "utf-8");
    const agent = personaToAgent(content);
    const jsonName = file.replace(".yaml", ".json");
    fs.writeFileSync(
      path.join(agentsDir, jsonName),
      JSON.stringify(agent, null, 2) + "\n"
    );
  }
}

// 2. Copy skills
cpR(path.join(SRC, "skills"), path.join(OUT, "skills"));

// 3. Copy stages
cpR(path.join(SRC, "stages"), path.join(OUT, "stages"));

// 4. Copy conventions
cpR(path.join(SRC, "conventions"), path.join(OUT, "conventions"));

// 5. Copy tools
cpR(path.join(SRC, "tools"), path.join(OUT, "tools"));

// 6. Copy Kiro-specific hooks
const hooksSrc = path.join(SRC, "target-config", "kiro-ide", "hooks");
const hooksDest = path.join(OUT, "hooks");
fs.mkdirSync(hooksDest, { recursive: true });
if (fs.existsSync(hooksSrc)) {
  for (const file of fs.readdirSync(hooksSrc)) {
    if (file.startsWith(".")) continue;
    fs.copyFileSync(path.join(hooksSrc, file), path.join(hooksDest, file));
  }
}

// 7. Verify
console.log("Verifying ...");
let failures = 0;

// JSON files must parse
const jsonFiles = [];
function findJson(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findJson(full);
    else if (entry.name.endsWith(".json") || entry.name.endsWith(".kiro.hook")) jsonFiles.push(full);
  }
}
findJson(OUT);

for (const file of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    console.error(`  FAIL: invalid JSON: ${file}`);
    failures++;
  }
}

// SKILL.md must have name:
const skillFiles = [];
function findSkills(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findSkills(full);
    else if (entry.name === "SKILL.md") skillFiles.push(full);
  }
}
findSkills(path.join(OUT, "skills"));

for (const file of skillFiles) {
  const content = fs.readFileSync(file, "utf-8");
  if (!/^name:/m.test(content)) {
    console.error(`  FAIL: ${file} missing name: in frontmatter`);
    failures++;
  }
}

// process-checker.js must syntax-check
const checker = path.join(OUT, "tools", "process-checker.js");
if (fs.existsSync(checker)) {
  try {
    execSync(`node --check "${checker}"`, { stdio: "pipe" });
  } catch {
    console.error("  FAIL: process-checker.js has syntax errors");
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} verification failure(s).`);
  process.exit(1);
}

console.log("  → dist/kiro-ide/.kiro/");
