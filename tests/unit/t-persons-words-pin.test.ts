// The engine never reads the person's words to decide (DESIGN.md section 2.4, the S7 row): every place in core/ and
// harness/ that uses what the person typed is on tests/harness/persons-words-readers.ts, either ALLOWED with its reason
// or STILL_TO_GO with the reading slice that removes it, and what it does with the words (decides or keeps) is what the
// list says. The scanner follows the words by the TypeScript checker from the message store, the gate-words record,
// the hook's prompt and every copy the engine keeps; persons-words-readers.ts says how.
//
// Red both ways: a place the list does not name (a new reader), a place that now decides where the list says it keeps,
// a new caller handing the words to a helper; and a line whose place no longer reads them (its slice landed: delete
// the line). The fixtures in tests/fixtures/persons-words-pin/ are the reds the scanner must see: a comparison, a
// normalised comparison, a destructure, a helper's parameter, a field the engine hands out, the gate words, a switch,
// the protected response's copy, an audit row's Person Reply, a digest of their text, the store file parsed by hand.
//
// Not reached by the scan: the adapters' own parsing of their host's input (untyped JSON in harness/*/hooks:
// Copilot's run, the Kiro CLI adapter's run, the Kiro IDE adapter's messageOrigin). Those keep their names on
// ALLOWED_UNREACHED, held to their use if a typed read appears.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { sep } from "node:path";
import {
  AGENT_ARGUMENT_CHECKS, ALLOWED, ALLOWED_UNREACHED, type Found, pinFixtureFiles, RECORD_COPIES, scanPersonsWords,
  STILL_TO_GO,
} from "../harness/persons-words-readers.ts";

setDefaultTimeout(180_000);

let scanned: Map<string, Found> | undefined;
const engine = (): Map<string, Found> => (scanned ??= scanPersonsWords());

const where = (found: Found): string => [...found.uses].map(([kind, at]) => `${kind} at ${at}`).slice(0, 3).join("; ");

describe("the scanner sees each shape a reader of the person's words has taken", () => {
  let fixtures: Map<string, Found> | undefined;
  const found = () => (fixtures ??= scanPersonsWords({ files: pinFixtureFiles() }));
  const READS = [
    "approvedByWords", "approvedAfterNormalising", "saidYes", "looksLikeYes", "latestSaidYes", "gatePickNumber",
    "reviewWordsApprove", "latestTurnChoice", "protectedSaidApprove", "approvalReplyWasApprove", "sameReplyAsBefore",
    "storeFileSaysApprove",
  ];

  test("each fixture reader is a place that decides", () => {
    const places = found();
    const decides = (name: string) => places.get(`tests/fixtures/persons-words-pin/readers.ts#${name}`)?.use;
    expect(Object.fromEntries(READS.map((name) => [name, decides(name)]))).toEqual(Object.fromEntries(READS.map((name) => [name, "decides"])));
  });

  test("a helper handed the words names who handed them", () => {
    expect([...(found().get("tests/fixtures/persons-words-pin/readers.ts#looksLikeYes")?.from ?? [])])
      .toEqual(["tests/fixtures/persons-words-pin/readers.ts#latestSaidYes"]);
  });

  test("a copy is a place that keeps, and a function that never touches the words is no place", () => {
    const places = found();
    expect(places.get("tests/fixtures/persons-words-pin/keepers.ts#personReplyFields")?.use).toBe("keeps");
    expect(places.has("tests/fixtures/persons-words-pin/keepers.ts#messageStamp")).toBe(false);
  });

  test("a file named as the compiler does not write it (Windows: a drive letter and backslashes) is still scanned", () => {
    // The compiler writes each file's name its own way (forward slashes, no "." step); the scan must key by that.
    const written = pinFixtureFiles().map((file) => file.replace(/[\\/](readers|keepers)\.ts$/, (_, name: string) => `${sep}.${sep}${name}.ts`));
    expect(scanPersonsWords({ files: written }).get("tests/fixtures/persons-words-pin/readers.ts#approvedByWords")?.use).toBe("decides");
  });

  test("an unlisted reader fails the pin, named with how it reads", () => {
    const misses = pinMisses(found(), {}, {});
    expect(misses.some((line) => line.startsWith("tests/fixtures/persons-words-pin/readers.ts#approvedByWords: a new place that decides"))).toBe(true);
  });
});

/** Every way the places found and the lists differ, one line each. */
function pinMisses(found: Map<string, Found>, allowed: Record<string, { use: string; from?: readonly string[] }>,
  toGo: Record<string, { use: string; slice?: string; from?: readonly string[] }>, unreached: Record<string, { use: string }> = {}): string[] {
  const misses: string[] = [];
  const listed = { ...allowed, ...toGo };
  for (const [key, place] of found) {
    const entry = listed[key] ?? unreached[key];
    if (!entry) {
      misses.push(`${key}: a new place that ${place.use === "decides" ? "decides on" : "keeps"} the person's words (${where(place)}; from ${[...place.from].join(", ") || "its own read"})`);
      continue;
    }
    if (entry.use !== place.use) misses.push(`${key}: the list says it ${entry.use}, it now ${place.use === "decides" ? "decides" : "keeps"} (${where(place)})`);
    const from = [...place.from].sort();
    const needsFrom = place.sources.size === 0 && from.length > 0;
    const listedFrom = "from" in entry && entry.from ? [...entry.from].sort() : null;
    if ((needsFrom || listedFrom !== null) && JSON.stringify(listedFrom ?? []) !== JSON.stringify(from)) {
      misses.push(`${key}: handed the words by ${from.join(", ") || "nothing"}, the list says ${listedFrom?.join(", ") ?? "nothing"}`);
    }
  }
  for (const [key, entry] of Object.entries(listed)) {
    if (!found.has(key)) misses.push(`${key}: listed (${"slice" in entry && entry.slice ? `still to go, ${entry.slice}` : "allowed"}) but no longer reads the person's words; delete its line`);
  }
  return misses;
}

describe("the engine's places that use the person's words are the list's, both ways", () => {
  test("every place found is listed with its use, and every line still reads", () => {
    expect(pinMisses(engine(), ALLOWED, STILL_TO_GO, ALLOWED_UNREACHED)).toEqual([]);
  });

  test("no key is on two lists", () => {
    const both = Object.keys(ALLOWED).filter((key) => key in STILL_TO_GO || key in ALLOWED_UNREACHED);
    expect(both).toEqual([]);
  });

  test("the agent-argument checks read the agent's arguments only", () => {
    expect(AGENT_ARGUMENT_CHECKS.filter((key) => engine().has(key))).toEqual([]);
  });

  test("each record copy named by hand is still read as the person's words somewhere", () => {
    const named = new Set([...engine().values()].flatMap((place) => [...place.sources]));
    expect(RECORD_COPIES.map(({ type, field }) => `${type}.${field}`).filter((copy) => !named.has(copy))).toEqual([]);
  });

  test("every still-to-go line names its slice and row", () => {
    const missing = Object.entries(STILL_TO_GO).filter(([, entry]) => !entry.slice || !entry.row || !entry.why).map(([key]) => key);
    expect(missing).toEqual([]);
  });
});
