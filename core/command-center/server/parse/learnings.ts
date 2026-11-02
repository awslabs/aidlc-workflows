const CID = /^- (.*?)\s*(?:\(learned (\d{4}-\d{2}-\d{2})\))?\s*<!--\s*cid:([a-z0-9-]+):([a-z0-9]+)\s*-->\s*$/;
export function parseLearnings(files: Record<string, string>): { stage: string; cid: string; date: string | null; text: string; file: string }[] {
  const out: { stage: string; cid: string; date: string | null; text: string; file: string }[] = [];
  for (const [file, md] of Object.entries(files)) for (const line of md.split("\n")) {
    const m = line.match(CID); if (m) out.push({ stage: m[3]!, cid: m[4]!, date: m[2] ?? null, text: m[1]!.trim(), file });
  }
  return out;
}
