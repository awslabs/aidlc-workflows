/**
 * Test-only checks for two observed intent-capture overclaims. This recognizes
 * bounded wording patterns, not arbitrary semantic entailment. The production
 * claim-sources sensor separately validates citations and assumption approval.
 */
export interface IntentGroundingFinding {
  kind: "external-customers-excluded" | "developer-is-end-user";
  artifact: string;
  claim: string;
  citedSources: string[];
}

interface Block { section: string; text: string }
interface ConfirmedSource { text: string; personalCustomer: boolean }

function visibleLines(markdown: string): string[] {
  let fence = "";
  return markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/).map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      return "";
    }
    return fence ? "" : line;
  });
}

function blocks(markdown: string): Block[] {
  // Let Bun resolve Markdown links/references over the complete document.
  // Their labels and inline code must not turn into literal source citations.
  const rendered = Bun.markdown.render(markdown, {
    heading: (text, meta) => `${"#".repeat(meta.level)} ${text}\n\n`,
    paragraph: (text) => `${text}\n\n`,
    listItem: (text) => `${text}\n\n`,
    tr: (text) => `${text}\n\n`,
    th: (text) => `| ${text} `,
    td: (text) => `| ${text} `,
    link: (text) => text.replace(/[[\]]/g, ""),
    image: () => "",
    code: () => "",
    codespan: (text) => text.replace(/\[(?:desc|scope|Q\d+|memory:[^\]]+|assumption)\]/g, ""),
    html: (text) => text.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " "),
  });
  const result: Block[] = [];
  let section = "";
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) result.push({ section, text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const line of rendered.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      if (heading[1].length <= 2) section = heading[2];
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (/^\s*\|/.test(line)) {
      flush();
      result.push({ section, text: line.trim() });
    } else if (/^\s*(?:[-*+]\s|\d+[.)]\s)/.test(line)) {
      flush();
      paragraph.push(line.trim());
    } else paragraph.push(line.trim());
  }
  flush();
  return result;
}

function plain(text: string): string {
  return text.replace(/\[(?:desc|scope|Q\d+|memory:[^\]]+|assumption)\]/g, "")
    .replace(/[*`_~]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
    .replaceAll("’", "'").replace(/n't\b/g, " not").replace(/\bcannot\b/g, "can not");
}

function asserted(text: string): string[] {
  return plain(text).split(/(?<=[.!?;])\s+/).filter((part) =>
    !part.endsWith("?") &&
    !/\b(?:whether|may|might|could|unknown|unconfirmed|undecided|not yet known)\b/.test(part),
  );
}

const external = String.raw`external\s+(?:product\s+)?customers?`;
function excludesExternal(text: string): boolean {
  return asserted(text).some((part) => {
    if (new RegExp(`${external}[^.!?;]*\\b(?:not|never)\\s+(?:necessarily\\s+)?(?:excluded|out of scope)\\b`).test(part)) return false;
    if (new RegExp(`\\b(?:not|never)\\s+exclude\\b[^.!?;]*\\b${external}\\b`).test(part)) return false;
    if (/\bnot\s+(?:aimed(?: at)?|intended(?: for)?|for)\s+(?:only|solely|exclusively)\b/.test(part)) return false;
    return new RegExp(`\\bno\\s+${external}\\b`).test(part) ||
      new RegExp(`\\b(?:not\\s+(?:aimed at|intended for|for)|excludes?|excluding|does not\\s+(?:serve|include|target|support))\\b[^.!?;]*\\b${external}\\b`).test(part) ||
      new RegExp(`\\b${external}\\b[^.!?;]*\\b(?:excluded|out of scope)\\b`).test(part);
  });
}

function samePerson(text: string): boolean {
  return asserted(text).some((part) => {
    if (!/\bdeveloper\b/.test(part) || !/\bend[- ]users?\b/.test(part)) return false;
    if (/\b(?:not|never)\b[^.!?;]{0,50}\b(?:same|one|single|also)\b/.test(part)) return false;
    return /\b(?:same|one|single)\s+(?:person|individual)\b/.test(part) ||
      /\bdeveloper\s*(?:\(\s*)?(?:is\s+)?also\s+(?:the\s+)?end[- ]user\b/.test(part) ||
      /\bend[- ]user\s+is\s+(?:also\s+)?the\s+developer\b/.test(part);
  });
}

function confirmedAnswers(markdown: string): Map<string, ConfirmedSource> {
  const answers = new Map<string, ConfirmedSource>();
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const sections = visibleLines(markdown).join("\n").split(/^##[ \t]+/m).slice(1);
  for (const section of sections) {
    const id = /^(Q\d+)\./.exec(section)?.[1];
    const answerRows = [...section.matchAll(/^\[Answer\]:[ \t]*([^\r\n]*)$/gm)];
    const answer = answerRows.length === 1 ? answerRows[0][1].trim() : "";
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
    if (!answer) continue;
    // Resolve a bare selected label; never search the other options as evidence.
    const label = /^([A-Z])\.?$/.exec(answer.trim())?.[1];
    const selected = label
      ? new RegExp(`^\\s*(?:[-*]\\s+)?${label}[.)]\\s+(.+)$`, "m").exec(section)?.[1] ?? ""
      : answer.replace(/^[A-Z][.)]\s+/, "");
    // This is the captured customer option, not generic "just me" authority.
    // In particular Q5's decision-making answer cannot identify the end user.
    const prompt = section.split(/\n(?:[ \t]*(?:[-*][ \t]+)?[A-Z][.)][ \t]+|\[Answer\]:)/)[0];
    const customerQuestion = prompt.split("\n").some((line) =>
      /\bwho\s+(?:(?:will|would|can|should)\s+use|uses?|(?:is|are)\s+(?:(?:the|our|your|intended|target|end)\s+)*(?:customers?|users?))\b/i.test(line) ||
      /^(?:Q\d+\.\s*)?(?:target|intended)\s+(?:audience|users?|customers?)[?.:]?\s*$/i.test(line),
    );
    const personalCustomer = customerQuestion &&
      /^just me\s*\(\s*developer\s*\/\s*personal use\s*\)[.!]?$/i.test(selected.trim());
    answers.set(id, { text: selected, personalCustomer });
  }
  for (const id of duplicates) answers.delete(id);
  return answers;
}

export function findIntentGroundingRegressions(input: {
  description: string;
  questions: string;
  artifacts: ReadonlyArray<{ name: string; markdown: string }>;
}): IntentGroundingFinding[] {
  const sources = confirmedAnswers(input.questions);
  sources.set("desc", { text: input.description, personalCustomer: false });
  const findings: IntentGroundingFinding[] = [];
  const rules = [
    ["external-customers-excluded", excludesExternal],
    ["developer-is-end-user", samePerson],
  ] as const;
  for (const artifact of input.artifacts) {
    for (const block of blocks(artifact.markdown)) {
      if (/^Review$/i.test(block.section)) continue;
      // Approval/placement of labelled assumptions remains the sensor's job.
      if (/^Assumptions & Open Questions$/i.test(block.section) && /\[assumption\]/.test(block.text)) continue;
      const citedSources = [...new Set([...block.text.matchAll(/\[(desc|Q\d+)\]/g)].map((m) => m[1]))];
      for (const [kind, recognizes] of rules) {
        if (recognizes(block.text) && !citedSources.some((id) => {
          const source = sources.get(id);
          return source && (source.personalCustomer || recognizes(source.text));
        })) {
          findings.push({ kind, artifact: artifact.name, claim: block.text, citedSources });
        }
      }
    }
  }
  return findings;
}
