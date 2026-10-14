// Releases 2.8.0 to 2.11.0 refresh a project from a newer release's files with
// their own code: it writes the scope and stage tables into the newer /aidlc
// skill, and stops when the skill has no place for them. The tables live in
// tables.md beside the skill now, so the shipped skill keeps one empty place
// where those releases read it (the harness folder's own skills, else
// .agents/skills). The stage pair sits inside the scope pair, so their second
// write, the scope table, replaces their first: only the scope table lands,
// until the project's next refresh by its own, newer, tool. The line can be
// dropped when no supported project still refreshes with a 2.8.0 to 2.11.0 tool.
export const EARLIER_RELEASE_REGIONS =
  "<!-- BEGIN: compiled scope grid via an earlier release's refresh -->" +
  "<!-- BEGIN: compiled stage graph via --><!-- END: compiled stage graph -->" +
  "<!-- END: compiled scope grid -->";

export function earlierReleasesReadSkill(skillRel: string, harnessDir: string): boolean {
  const rel = skillRel.split(/[\\/]/).join("/");
  return rel === `${harnessDir}/skills/aidlc/SKILL.md` || rel === ".agents/skills/aidlc/SKILL.md";
}
