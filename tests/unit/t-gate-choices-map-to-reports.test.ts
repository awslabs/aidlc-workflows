// Every choice a stage gate offers the person is one the stage protocol says
// how to record. The Ideation hand-off gate offered "Reject Initiative (end
// workflow)" and the last Operation gate "Start New Ideation Cycle", and no
// protocol report or engine path handled either, so a pick of them was
// recorded as something else or not at all. The protocol is the one owner of
// what a gate choice does: the handled choices are read from stage-protocol.md
// (section 2 Part 0 step 4, each naming its report, and the conditional
// "Approve, and add [stage] next" choice, which `next --add` carries out), and
// every choice a shipped stage file or protocol question offers must be one of
// them. It reads our own shipped prose, never a person's words.
//
// Mechanism: readFileSync over core/aidlc-common and plugins/*/stages; no CLI.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const COMMON = join(ROOT, "core", "aidlc-common");
const PROTOCOL = join(COMMON, "protocols", "stage-protocol.md");

const lines = (path: string): string[] => readFileSync(path, "utf-8").split(/\r?\n/);
const markdownFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? markdownFiles(path) : path.endsWith(".md") ? [path] : [];
});

// One label as the prose writes it: bold, quotes, a closing description in
// parentheses and a full stop are not part of the choice.
const label = (text: string): string =>
  text.replace(/\*\*/g, "").replace(/"/g, "").replace(/\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*$/, "").replace(/\.\s*$/, "").trim();

// "A / B / C" as written after a gate's lead-in: either in parentheses, or up
// to the sentence's end.
function choiceList(text: string): string[] {
  let list = text.trim();
  if (list.startsWith("(")) {
    let depth = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i] === "(") depth++;
      else if (list[i] === ")" && --depth === 0) {
        list = list.slice(1, i);
        break;
      }
    }
  } else {
    list = list.split(/\.(?:\s|$)/)[0];
  }
  return list.split(" / ").map(label).filter(Boolean);
}

function questionBlocks(text: string): string[][] {
  return [...text.matchAll(/```question\r?\n([\s\S]*?)```/g)]
    .filter((block) => /^header:\s*Approval\s*$/m.test(block[1]))
    .map((block) => [...block[1].matchAll(/^\s*- label:\s*(.+?)\s*$/gm)].map((match) => label(match[1])));
}

const GATE_LEAD = /(?:^Approval gate:\s*(?:strictly 2-option\s*)?|Standard approval gate\s*|2-option approval\s*|approval question with options:\s*)(.*)$/i;

// The choices one file offers at a gate, in every way the stage files say it.
function offeredChoices(path: string): string[] {
  const text = lines(path);
  const offered: string[] = [];
  text.forEach((raw, index) => {
    const line = raw.replace(/^\s*-\s+/, "");
    const lead = GATE_LEAD.exec(line);
    if (lead) {
      if (lead[1].trim() !== "") {
        offered.push(...choiceList(lead[1]));
        return;
      }
      for (let next = index + 1; next < text.length && /^\s+-\s/.test(text[next]); next++) {
        offered.push(label(text[next].replace(/^\s+-\s+/, "")));
      }
      return;
    }
    // "with two options: **Approve** (...) and **Request Changes**", over the
    // lines of the same numbered step.
    if (/\bwith (?:two|three) options:/.test(raw)) {
      const step = [raw];
      for (let next = index + 1; next < text.length && /^\s+\S/.test(text[next]) && !/^\s*\d+\.\s/.test(text[next]); next++) {
        step.push(text[next]);
      }
      offered.push(...[...step.join(" ").matchAll(/\*\*([^*]+)\*\*/g)].map((match) => label(match[1])));
    }
  });
  offered.push(...questionBlocks(text.join("\n")).flat());
  return offered;
}

// The protocol's own list: each Part 0 choice with the report that records it.
function handledChoices(): { handled: string[]; reports: Record<string, string> } {
  const text = lines(PROTOCOL);
  const part0 = text.findIndex((line) => line.startsWith("### Part 0"));
  const step4 = text.findIndex((line, index) => index > part0 && /^4\.\s/.test(line));
  expect(part0, "stage-protocol.md section 2 Part 0").toBeGreaterThan(-1);
  expect(step4, "Part 0 step 4").toBeGreaterThan(part0);
  const reports: Record<string, string> = {};
  for (let index = step4 + 1; index < text.length && /^\s+- \*\*/.test(text[index]); index++) {
    const bullet = /^\s+- \*\*([^*]+)\*\*(.*)$/.exec(text[index])!;
    reports[bullet[1].trim()] = bullet[2];
  }
  const handled = Object.keys(reports);
  const start = text.findIndex((line) => line.startsWith("### For stages with conditional options"));
  expect(start, "the conditional-options section").toBeGreaterThan(-1);
  const end = text.findIndex((line, index) => index > start && line.startsWith("### "));
  const section = text.slice(start, end).join("\n");
  expect(section, "the conditional choice is carried out by next --add").toContain("orchestrate next --add <slug>");
  handled.push(...questionBlocks(section).flat().filter((choice) => !handled.includes(choice)));
  return { handled, reports };
}

const matches = (handled: string, offered: string): boolean =>
  new RegExp(`^${handled.replace(/[.*+?^${}()|\\]/g, "\\$&").replace(/\\?\[[^\]]+\\?\]/g, ".+")}$`).test(offered);

const STAGE_FILES = [
  ...markdownFiles(join(COMMON, "stages")),
  ...readdirSync(join(ROOT, "plugins"))
    .map((plugin) => join(ROOT, "plugins", plugin, "stages"))
    .filter((dir) => existsSync(dir))
    .flatMap(markdownFiles),
];
const PROTOCOL_FILES = markdownFiles(join(COMMON, "protocols"));
const name = (path: string): string => relative(ROOT, path).split(sep).join("/");

describe("every gate choice offered maps to a report the stage protocol handles", () => {
  const { handled, reports } = handledChoices();

  test("the protocol names a report for each of its gate choices", () => {
    expect(handled).toContain("Approve");
    expect(handled).toContain("Request Changes");
    for (const [choice, how] of Object.entries(reports)) {
      const same = /same as (\w[\w -]*?),/.exec(how)?.[1];
      expect(how.includes("orchestrate report") || (same !== undefined && reports[same]?.includes("orchestrate report")), choice).toBe(true);
    }
  });

  test("every stage outside Initialization offers its gate choices in a form this check reads", () => {
    const silent = STAGE_FILES
      .filter((path) => !name(path).includes("/stages/initialization/"))
      .filter((path) => offeredChoices(path).length === 0)
      .map(name);
    expect(silent).toEqual([]);
    expect(STAGE_FILES.length).toBeGreaterThan(30);
  });

  test("no stage file or protocol question offers a choice nothing records", () => {
    const dead = [...STAGE_FILES, ...PROTOCOL_FILES].flatMap((path) =>
      offeredChoices(path)
        .filter((choice) => !handled.some((known) => matches(known, choice)))
        .map((choice) => `${name(path)}: ${choice}`));
    expect(dead).toEqual([]);
  });
});
