// scripts/harness-bindings.ts - ship each tool only its own protocol bindings.
//
// Several core protocol modules end a section with one `### <tool>` subsection
// per harness (the construction, topology, reviewer and swarm bindings). Each
// harness reads only its own, so a dist tree that carried all seven would hand
// the agent six other tools' instructions on every load. The packager keeps the
// matching subsection and drops the rest.
//
// A run is the seven tool headings in a row at one level, ended by the next
// heading at that level or above, or the end of the file. Fenced code is not
// read for headings. A tool heading outside a complete run, a run missing a
// tool, or a run naming one twice is a build error, so a new harness or a
// renamed heading is caught at package time instead of shipping a gap.

/** The binding subsection heading each manifest name reads. */
export const BINDING_HEADINGS: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  kiro: "Kiro CLI",
  "kiro-ide": "Kiro IDE",
  codex: "Codex CLI",
  cursor: "Cursor",
  opencode: "opencode",
  copilot: "GitHub Copilot",
};

const TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(BINDING_HEADINGS));

type Heading = { line: number; level: number; text: string };

function headingsOutsideFences(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (match) headings.push({ line: index, level: match[1].length, text: match[2] });
  });
  return headings;
}

/**
 * The module as `harness` ships it: every binding run cut to that tool's own
 * subsection. A module with no tool headings is returned unchanged.
 */
export function keepOwnHarnessBindings(content: string, harness: string, file: string): string {
  const own = BINDING_HEADINGS[harness];
  if (own === undefined) {
    throw new Error(`harness bindings: ${file}: no binding heading is known for harness "${harness}".`);
  }
  const lines = content.split("\n");
  // A run that reaches the end of the file stops before the empty piece the
  // final newline leaves, so the module keeps its trailing newline, CRLF or LF.
  const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  const headings = headingsOutsideFences(lines);
  const drop = new Set<number>();
  let i = 0;
  while (i < headings.length) {
    const start = headings[i];
    if (!TOOL_NAMES.has(start.text)) {
      i++;
      continue;
    }
    // Collect the run: tool headings at this level, deeper headings inside them.
    const sections: Array<{ text: string; from: number; to: number }> = [];
    let j = i;
    while (j < headings.length) {
      const h = headings[j];
      if (h.level < start.level || (h.level === start.level && !TOOL_NAMES.has(h.text))) break;
      if (h.level === start.level) {
        if (sections.length > 0) sections[sections.length - 1].to = h.line;
        sections.push({ text: h.text, from: h.line, to: end });
      }
      j++;
    }
    if (j < headings.length) sections[sections.length - 1].to = headings[j].line;
    const names = sections.map((s) => s.text);
    const missing = [...TOOL_NAMES].filter((name) => !names.includes(name));
    if (missing.length > 0 || names.length !== TOOL_NAMES.size) {
      throw new Error(
        `harness bindings: ${file} line ${start.line + 1}: a binding run must name each tool once ` +
          `(found ${names.join(", ")}${missing.length > 0 ? `; missing ${missing.join(", ")}` : ""}).`,
      );
    }
    for (const section of sections) {
      if (section.text === own) continue;
      for (let line = section.from; line < section.to; line++) drop.add(line);
    }
    i = j;
  }
  if (drop.size === 0) return content;
  return lines.filter((_, index) => !drop.has(index)).join("\n");
}
