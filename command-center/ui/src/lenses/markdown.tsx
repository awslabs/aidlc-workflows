// A small, safe Markdown renderer: it builds React elements only (React escapes every string), never HTML strings.
// Covers what AIDLC artifacts use — headings, paragraphs, lists, tables, fenced code, quotes, rules, inline code,
// bold/italic, and links (rendered as their text; the target is in the hover title, nothing is navigable).
import type { ReactNode } from "react";

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|!\[([^\]]*)\]\(([^)\s]*)[^)]*\)|\[([^\]]+)\]\(([^)\s]*)[^)]*\)|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g;

export function inline(s: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = []; let last = 0; let n = 0;
  for (const m of s.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(s.slice(last, at));
    const k = `${key}.${n++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[2]!.trim() || m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<b key={k}>{inline(m[3] ?? m[4]!, k)}</b>);
    else if (m[5] !== undefined) out.push(<span key={k} className="dim" title={m[6]}>[image: {m[5] || m[6]}]</span>);
    else if (m[7] !== undefined) out.push(<span key={k} className="mdlink" title={m[8]}>{inline(m[7], k)}</span>);
    else out.push(<i key={k}>{inline(m[9] ?? m[10]!, k)}</i>);
    last = at + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

const cells = (line: string) => {
  let t = line.trim(); if (t.startsWith("|")) t = t.slice(1); if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
};
const isSep = (line: string | undefined) => !!line && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

export function Markdown({ src }: { src: string }) {
  const lines = src.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = []; let i = 0; let k = 0;
  const key = () => `b${k++}`;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = []; i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++; out.push(<pre key={key()} className="mdpre"><code>{body.join("\n")}</code></pre>); continue;
    }
    const h = HEAD.exec(line);
    if (h) {
      const lvl = h[1]!.length; const kids = inline(h[2]!, key());
      out.push(lvl === 1 ? <h3 key={key()}>{kids}</h3> : lvl === 2 ? <h4 key={key()}>{kids}</h4> : <h5 key={key()}>{kids}</h5>);
      i++; continue;
    }
    if (RULE.test(line)) { out.push(<hr key={key()} />); i++; continue; }
    if (line.trimStart().startsWith("|") && isSep(lines[i + 1])) {
      const head = cells(line); const rows: string[][] = []; i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(cells(lines[i++]!));
      const tk = key();
      out.push(
        <div key={tk} className="mdtable"><table>
          <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `${tk}h${j}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? "", `${tk}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    if (LIST.test(line)) {
      const items: { indent: number; ordered: boolean; text: string }[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]!);
        if (m) { items.push({ indent: m[1]!.replace(/\t/g, "  ").length, ordered: /\d/.test(m[2]!), text: m[3]! }); i++; continue; }
        // A lazy continuation line belongs to the previous item.
        if (lines[i]!.trim() && /^\s+/.test(lines[i]!) && items.length) { items[items.length - 1]!.text += ` ${lines[i]!.trim()}`; i++; continue; }
        break;
      }
      const base = Math.min(...items.map((x) => x.indent)); const lk = key();
      const Tag = items[0]!.ordered ? "ol" : "ul";
      out.push(
        <Tag key={lk}>{items.map((it, j) => {
          const task = /^\[( |x|X)\]\s+/.exec(it.text);
          const text = task ? it.text.slice(task[0].length) : it.text;
          return <li key={j} style={it.indent > base ? { marginLeft: `${Math.min(6, Math.round((it.indent - base) / 2))}em` } : undefined}>{task ? (task[1] === " " ? "☐ " : "☑ ") : null}{inline(text, `${lk}.${j}`)}</li>;
        })}</Tag>,
      );
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ""));
      out.push(<blockquote key={key()}><Markdown src={body.join("\n")} /></blockquote>); continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !FENCE.test(lines[i]!) && !HEAD.test(lines[i]!) && !RULE.test(lines[i]!) && !LIST.test(lines[i]!) && !/^\s{0,3}>/.test(lines[i]!) && !(lines[i]!.trimStart().startsWith("|") && isSep(lines[i + 1]))) para.push(lines[i++]!.trim());
    if (!para.length) { para.push(line.trim()); i++; }
    const pk = key();
    out.push(<p key={pk}>{inline(para.join(" "), pk)}</p>);
  }
  return <div className="md">{out}</div>;
}
