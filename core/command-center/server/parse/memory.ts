export function parseStageMemory(md: string): { interpretations: string[]; deviations: string[]; tradeoffs: string[]; openQuestions: string[] } {
  const out = { interpretations: [] as string[], deviations: [] as string[], tradeoffs: [] as string[], openQuestions: [] as string[] };
  let cur: string[] | null = null;
  for (const line of md.split("\n")) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) { const t = h[1]!.toLowerCase(); cur = t.startsWith("interpret") ? out.interpretations : t.startsWith("deviation") ? out.deviations : t.startsWith("tradeoff") ? out.tradeoffs : t.startsWith("open") ? out.openQuestions : null; continue; }
    const b = line.match(/^- (.*)$/); if (b && cur) cur.push(b[1]!.trim());
  }
  return out;
}
